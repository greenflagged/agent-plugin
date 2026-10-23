#!/usr/bin/env node
// PreToolUse hook logic for the GreenFlagged plugin. pre-install-check.sh
// runs this with the hook input JSON on stdin.
//
// What it does, in plain terms: the first time a session's Bash command
// installs a package by name, the hook denies that one command and tells the
// agent to check the package with the GreenFlagged MCP tools. Re-running the
// same command then proceeds. The pause is once per package name per session.
//
// "Installs a package by name" covers `npm install lodash`, `pnpm add x`,
// `yarn add x`, `bun add x`, the initialisers `npm create x` / `npm init x`
// (which fetch `create-x`), and the fetch-and-run forms `npx x`, `npm exec x`,
// `pnpm dlx x`, `yarn dlx x`, `bunx x` and `bun x x`.
// Bare installs (`npm install`, `npm ci`, `pnpm install --frozen-lockfile`,
// `yarn`) never pause. They install what the lockfile or package.json already
// names, and the hook has no reliable way to tell whether that changed.
//
// This is a heuristic over common command shapes, not a shell parser. It
// misses installs hidden in scripts, variables or command substitution.
//
// Why a deny and not a note: a non-blocking PreToolUse note reaches the agent
// only after the command already ran. A deny "blocks the tool call, and shows
// Claude the reason" (code.claude.com/docs/en/hooks, read 2026-10-20).
//
// Why it cannot loop: before it denies, the hook records every name in the
// command. An identical retry names nothing new, so it passes. If the hook
// cannot record the names, it does not deny.
//
// It fails open. Any error (bad input, unreadable state, an exception) means
// no output, and no output means Claude Code allows the command. It never
// prints "allow" and never exits 2.
//
// No dependencies on purpose: the public plugin repo ships no node_modules.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY_MS = 24 * 60 * 60 * 1000;
// Session state file names. Pruning touches nothing else.
const SESSION_FILE_RE = /^[A-Za-z0-9_-]{1,128}$/;
// `bash -c "npm i x"` is inspected recursively, but not without limit.
const MAX_NESTING = 3;

// ---------------------------------------------------------------------------
// Shell splitting
// ---------------------------------------------------------------------------

// Splits a command line into segments of words. Segments break on `&&`, `||`,
// `;`, `|`, `&` and newlines. Quotes are honoured and stripped. `#` at the
// start of a word begins a comment that runs to the end of the line.
// Redirections (`>out`, `2>&1`) are dropped.
//
// Heredoc bodies (`cat <<EOF ... EOF`) are data, so they are skipped. The
// exception is a body fed to a shell (`bash <<EOF`, `ssh host <<EOF`,
// `cat <<EOF | sh`): that body is a script, so it is returned as a
// `sh -c <body>` segment and inspected like any other command.
function splitSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const heredocs = []; // pending {delim, stripTabs, seg}

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  // Reads a heredoc delimiter starting at index i; returns the index after it.
  const readDelimiter = (i) => {
    let stripTabs = false;
    if (command[i] === '-') { stripTabs = true; i++; }
    while (command[i] === ' ' || command[i] === '\t') i++;
    let delim = '';
    let q = null;
    for (; i < command.length; i++) {
      const c = command[i];
      if (q) { if (c === q) q = null; else delim += c; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '\\') continue;
      if (/[\s;&|<>()]/.test(c)) break;
      delim += c;
    }
    // `seg` is the index the heredoc's own command will have in `segments`.
    if (delim) heredocs.push({ delim, stripTabs, seg: segments.length });
    return i;
  };

  const feedsShell = (seg) => {
    if (!seg) return false;
    const w = stripPrefixes(seg);
    const tool = w.length ? path.basename(w[0]) : '';
    return SHELLS.has(tool) || tool === 'ssh';
  };

  // Consumes heredoc bodies after a newline at index i; returns the index of
  // the last character consumed.
  const takeBodies = (i) => {
    while (heredocs.length) {
      const { delim, stripTabs, seg } = heredocs.shift();
      const script = feedsShell(segments[seg]) || segments.slice(seg + 1).some(feedsShell);
      const body = [];
      for (;;) {
        if (i >= command.length) break;
        let end = command.indexOf('\n', i);
        if (end === -1) end = command.length;
        let line = command.slice(i, end);
        if (stripTabs) line = line.replace(/^\t+/, '');
        i = end + 1;
        if (line === delim) break;
        body.push(line);
      }
      if (script && body.length) segments.push(['sh', '-c', body.join('\n')]);
    }
    return i - 1;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < command.length) {
      const next = command[++i];
      if (next !== '\n') { word += next; inWord = true; }
      continue;
    }
    if (c === '#' && !inWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '$' && command[i + 1] === '(' && command[i + 2] === '(') {
      // Arithmetic `$((1<<2))` stays one word, so its `<<` is not a heredoc.
      // It must end in `))`. `$((echo hi) && npm i x)` is a subshell inside a
      // command substitution, so it falls through and is split as commands.
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')' && --depth === 0) break;
      }
      if (j < command.length && command[j - 1] === ')') {
        word += command.slice(i, j + 1);
        inWord = true;
        i = j;
        continue;
      }
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      // A heredoc, even mid-word: bash reads `cat<<EOF` as `cat <<EOF`.
      // A leading fd number (`0<<EOF`) belongs to the operator.
      if (/^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      i = readDelimiter(i + 2) - 1;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n') {
      endSegment();
      if (heredocs.length) i = takeBodies(i + 1);
      continue;
    }
    if (c === ';' || c === '(' || c === ')') { endSegment(); continue; }
    if (c === '&' || c === '|') {
      // `2>&1` and `>&2` keep their `&` inside the redirection word.
      if (c === '&' && inWord && word.endsWith('>')) { word += c; continue; }
      endSegment();
      if (command[i + 1] === c) i++;
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment();

  return segments.map(dropRedirections).filter((s) => s.length);
}

function dropRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^\d*(>>?|<<?<?|&>)(&?\S*)$/.exec(w);
    if (m) {
      // A bare operator (`>`, `2>`) takes the next word as its target.
      if (m[2] === '' || m[2] === '&') i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

// Drops leading `FOO=bar` assignments and wrapper commands, so
// `sudo npm i x` and `timeout 60 npm i x` are seen as `npm i x`.
// Wrappers are matched by basename, so `/usr/bin/env` counts as `env`.
// `words` is how many plain words the wrapper takes before the command (the
// duration for `timeout`). `valueFlags` take the next word as their value.
const WRAPPERS = new Map([
  ['sudo', { words: 0, valueFlags: ['-u', '-g', '-C', '-p', '-D', '-h', '-U', '-r', '-t'] }],
  ['env', { words: 0, valueFlags: ['-u', '-C', '--unset', '--chdir'] }],
  ['time', { words: 0, valueFlags: ['-f', '-o'] }],
  ['command', { words: 0, valueFlags: [] }],
  ['exec', { words: 0, valueFlags: ['-a'] }],
  ['nohup', { words: 0, valueFlags: [] }],
  ['nice', { words: 0, valueFlags: ['-n', '--adjustment'] }],
  ['timeout', { words: 1, valueFlags: ['-k', '-s', '--kill-after', '--signal'] }],
  ['stdbuf', { words: 0, valueFlags: ['-i', '-o', '-e'] }],
]);

function stripPrefixes(words) {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const wrapper = WRAPPERS.get(path.basename(w));
    if (wrapper === undefined) break;
    i++;
    while (words[i] !== undefined && words[i].startsWith('-')) {
      if (wrapper.valueFlags.includes(words[i])) i++;
      i++;
    }
    for (let n = 0; n < wrapper.words && words[i] !== undefined; n++) i++;
  }
  return words.slice(i);
}

// ---------------------------------------------------------------------------
// Package-manager rules
// ---------------------------------------------------------------------------

// Flags that take the next word as their value. Without this list,
// `npm --prefix app install x` would read `app` as a package name.
// `--flag=value` forms are a single word and need no entry.
const COMMON_VALUE_FLAGS = ['--registry', '--loglevel', '--cache', '--userconfig'];
const NPM_VALUE_FLAGS = new Set([
  ...COMMON_VALUE_FLAGS, '--prefix', '-C', '-w', '--workspace', '--tag',
  '--omit', '--include', '--install-strategy', '--before', '--otp', '--scope',
  '--location', '--globalconfig', '--script-shell', '--audit-level', '--cpu',
  '--os', '--libc', '--save-prefix', '--auth-type', '--node-options',
]);
// In pnpm `-w` is `--workspace-root` and takes no value.
const PNPM_VALUE_FLAGS = new Set([...COMMON_VALUE_FLAGS, '--filter', '-F', '-C', '--dir', '--reporter', '--store-dir']);
const YARN_VALUE_FLAGS = new Set([...COMMON_VALUE_FLAGS, '--cwd', '--cache-folder', '--modules-folder']);
const BUN_VALUE_FLAGS = new Set([...COMMON_VALUE_FLAGS, '--cwd', '--backend', '--cache-dir', '--filter']);
// npx and npm exec accept npm's flags, plus their own.
const EXEC_VALUE_FLAGS = new Set([...NPM_VALUE_FLAGS, '-c', '--call', '--cwd']);

// npm accepts these spellings, typos included, for `install`.
const NPM_NAMED_VERBS = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta',
  'isntal', 'isntall', 'add', 'install-test', 'it',
]);
const NPM_EXEC_VERBS = new Set(['exec', 'x']);
const NPM_CREATE_VERBS = new Set(['create', 'init', 'innit']);
const PNPM_NAMED_VERBS = new Set(['add', 'install', 'i']);
const BUN_NAMED_VERBS = new Set(['add', 'install', 'i', 'a']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

// Splits words into the first positional (the verb) and what follows it.
// Value flags before the verb are skipped along with their values.
function verbAndRest(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return { verb: args[i + 1], rest: args.slice(i + 2) };
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return { verb: a, rest: args.slice(i + 1) };
  }
  return { verb: undefined, rest: [] };
}

// Positional words, with value flags and their values removed.
function positionals(args, valueFlags) {
  const out = [];
  let flagsDone = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!flagsDone && a === '--') { flagsDone = true; continue; }
    if (!flagsDone && a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// Fetch-and-run: npx, npm exec, bunx, pnpm dlx, yarn dlx. With
// `--package x` (or `-p x`) the packages are the --package values and the
// first positional is a binary name. Without it, the first positional is the
// package. Everything after the first positional belongs to the command run.
// `-c "<cmd>"` runs a shell command, which is inspected as `nested`.
function fetchAndRun(args, opts) {
  const packages = [];
  let first;
  let nested;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { first = args[i + 1]; break; }
    if (a === '-p' || a === '--package') { if (args[i + 1] !== undefined) packages.push(args[++i]); continue; }
    if (a.startsWith('--package=')) { packages.push(a.slice('--package='.length)); continue; }
    if (a === '-c' || a === '--call') { nested = args[++i]; continue; }
    if (a.startsWith('--call=')) { nested = a.slice('--call='.length); continue; }
    if (a.startsWith('-')) {
      if (EXEC_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    first = a;
    break;
  }
  if (nested !== undefined) return { names: packages, localBin: null, nested };
  if (packages.length) return { names: packages, localBin: null };
  if (first === undefined) return { names: [], localBin: null };
  return { names: [first], localBin: opts.localBinCheck ? first : null };
}

// `npm create vite` and `npm init vite` fetch `create-vite`.
// `@scope` becomes `@scope/create`, `@scope/x` becomes `@scope/create-x`.
// Only the first positional is the initialiser; the rest are its arguments.
function initialiser(args, valueFlags) {
  const first = positionals(args, valueFlags)[0];
  if (first === undefined) return { names: [], localBin: null };
  // A bare scope (`@vue`, `@vue@latest`) fetches `@vue/create`.
  const scopeOnly = /^(@[a-z0-9][\w.-]*)(@[^/]*)?$/i.exec(first);
  if (scopeOnly) return { names: [`${scopeOnly[1]}/create`], localBin: null };
  const name = registryName(first);
  if (name === null) return { names: [], localBin: null };
  let pkg;
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    pkg = `${name.slice(0, slash)}/create-${name.slice(slash + 1)}`;
  } else {
    pkg = name.startsWith('create-') ? name : `create-${name}`;
  }
  return { names: [pkg], localBin: null };
}

// Returns {names, localBin, nested} for one segment. `localBin` is set for
// npx-style runs that npx would satisfy from node_modules/.bin without
// fetching. `nested` is the command string of `bash -c "..."`.
function inspectSegment(words) {
  const none = { names: [], localBin: null };
  if (!words.length) return none;
  const tool = path.basename(words[0]);
  const args = words.slice(1);

  if (SHELLS.has(tool)) {
    // `bash -c "npm i x"`, `sh -ec '...'`: inspect the string.
    for (let i = 0; i < args.length; i++) {
      if (/^-[a-z]*c[a-z]*$/.test(args[i]) && args[i + 1] !== undefined) {
        return { names: [], localBin: null, nested: args[i + 1] };
      }
      if (args[i] === '-o' || args[i] === '+o' || args[i] === '-O' || args[i] === '+O') { i++; continue; }
      if (!args[i].startsWith('-') && !args[i].startsWith('+')) break;
    }
    return none;
  }

  if (tool === 'npx') return fetchAndRun(args, { localBinCheck: true });
  if (tool === 'bunx') return fetchAndRun(args, { localBinCheck: true });

  if (tool === 'npm') {
    const { verb, rest } = verbAndRest(args, NPM_VALUE_FLAGS);
    if (NPM_NAMED_VERBS.has(verb)) return { names: positionals(rest, NPM_VALUE_FLAGS), localBin: null };
    if (NPM_EXEC_VERBS.has(verb)) return fetchAndRun(rest, { localBinCheck: true });
    if (NPM_CREATE_VERBS.has(verb)) return initialiser(rest, NPM_VALUE_FLAGS);
    return none;
  }

  if (tool === 'pnpm') {
    const { verb, rest } = verbAndRest(args, PNPM_VALUE_FLAGS);
    if (PNPM_NAMED_VERBS.has(verb)) return { names: positionals(rest, PNPM_VALUE_FLAGS), localBin: null };
    if (verb === 'dlx') return fetchAndRun(rest, { localBinCheck: false });
    if (verb === 'create') return initialiser(rest, PNPM_VALUE_FLAGS);
    return none;
  }

  if (tool === 'yarn') return inspectYarn(args);

  if (tool === 'bun') {
    const { verb, rest } = verbAndRest(args, BUN_VALUE_FLAGS);
    if (BUN_NAMED_VERBS.has(verb)) return { names: positionals(rest, BUN_VALUE_FLAGS), localBin: null };
    if (verb === 'x') return fetchAndRun(rest, { localBinCheck: true });
    if (verb === 'create') return initialiser(rest, BUN_VALUE_FLAGS);
    return none;
  }

  return none;
}

function inspectYarn(args) {
  const { verb, rest } = verbAndRest(args, YARN_VALUE_FLAGS);
  if (verb === 'add') return { names: positionals(rest, YARN_VALUE_FLAGS), localBin: null };
  if (verb === 'dlx') return fetchAndRun(rest, { localBinCheck: false });
  if (verb === 'create') return initialiser(rest, YARN_VALUE_FLAGS);
  // `yarn workspace <name> add x` and `yarn global add x` re-dispatch on the
  // inner verb.
  if (verb === 'workspace') return inspectYarn(rest.slice(1));
  if (verb === 'global') return inspectYarn(rest);
  return { names: [], localBin: null };
}

// The registry package a spec fetches, or null when it fetches none.
// `lodash@^4` -> `lodash`, `@scope/pkg@1.2` -> `@scope/pkg`.
// Aliases resolve to their target: `x@npm:lodash-es@4` -> `lodash-es`.
// Local paths, URLs, git and tarball specs, and GitHub shorthand
// (`user/repo`) have no registry name, so they return null.
function registryName(spec) {
  if (!spec) return null;
  const alias = spec.indexOf('@npm:', 1);
  if (alias !== -1) return registryName(spec.slice(alias + '@npm:'.length));
  if (spec.startsWith('npm:')) return registryName(spec.slice(4));
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null; // file:, git+, https:, github:
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~')) return null;
  if (/\.(tgz|tar\.gz|tar)$/.test(spec)) return null;
  if (!spec.startsWith('@') && spec.includes('/')) return null;
  const at = spec.indexOf('@', 1);
  // `pkg@workspace:*`, `pkg@link:../x`, `pkg@file:..`: not fetched from a registry.
  if (at !== -1 && /^[a-z][a-z0-9+.-]*:/i.test(spec.slice(at + 1))) return null;
  const name = at === -1 ? spec : spec.slice(0, at);
  // npm names are URL-safe; anything else is not a registry name.
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : null;
}

// npx prefers a binary from node_modules/.bin, found by walking up from the
// working directory, and fetches nothing when one exists.
function hasLocalBin(dir, spec) {
  const name = registryName(spec);
  if (name === null || name !== spec) return false; // a version was asked for, so npx may fetch
  const bin = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  // registryName already rejects these; checked again because a bad name here
  // would probe paths outside node_modules/.bin.
  if (!bin || bin.includes('/') || bin.includes('\\') || bin.includes('..')) return false;
  let d = dir;
  for (;;) {
    try {
      if (fs.existsSync(path.join(d, 'node_modules', '.bin', bin))) return true;
    } catch (_) {
      return false;
    }
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

// Every package name the command would fetch, in order, without duplicates.
function packagesIn(command, startCwd, depth = 0, acc = { seen: new Set(), names: [] }) {
  let cwd = startCwd;
  for (const raw of splitSegments(command)) {
    const words = stripPrefixes(raw);
    if (!words.length) continue;
    if (words[0] === 'cd') {
      // `cd app && npm i x` installs into app. A bare `cd` goes home.
      cwd = words[1] === undefined ? os.homedir() : path.resolve(cwd, words[1]);
      continue;
    }
    const { names: specs, localBin, nested } = inspectSegment(words);
    if (nested !== undefined && depth < MAX_NESTING) packagesIn(nested, cwd, depth + 1, acc);
    if (localBin !== null && hasLocalBin(cwd, localBin)) continue;
    for (const spec of specs) {
      const name = registryName(spec);
      if (name && !acc.seen.has(name)) { acc.seen.add(name); acc.names.push(name); }
    }
  }
  return acc.names;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

// One file per session, listing the names already paused on, one per line.
// It lives under CLAUDE_PLUGIN_DATA, which survives plugin updates. If that is
// unset or unusable, a per-user temp directory is used instead.
//
// The temp fallback may sit in a shared /tmp. So the directories are created
// mode 0700 and checked with lstat: each must be a real directory (not a
// symlink) owned by this user. Otherwise another user could point the hook at
// their own files (CWE-59).
function stateDirs() {
  const dirs = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    dirs.push({ checked: [], dir: path.join(process.env.CLAUDE_PLUGIN_DATA, 'sessions') });
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const base = path.join(process.env.TMPDIR || os.tmpdir() || '/tmp', `greenflagged-plugin-${uid}`);
  dirs.push({ checked: [base], dir: path.join(base, 'sessions') });
  return dirs;
}

function isOwnDir(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return false;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
  return true;
}

// Creates each directory if needed and checks it before going deeper, so
// nothing is created through a planted symlink. Throws if unsafe.
// For CLAUDE_PLUGIN_DATA, `checked` is empty and the parents come from
// Claude Code, so they are created recursively.
function ensureDir({ checked, dir }) {
  if (!checked.length) fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  for (const p of [...checked, dir]) {
    try {
      fs.mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (!isOwnDir(p)) throw new Error(`unsafe state dir ${p}`);
  }
  return dir;
}

function sessionFileName(sessionId) {
  const clean = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return clean || 'unknown';
}

// Reads the names already recorded for this session. Returns null when the
// state cannot be read safely, which makes the caller allow the command.
function readState(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    return new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
  } catch (e) {
    return e && e.code === 'ENOENT' ? new Set() : null;
  }
}

// Returns the state file that already exists for this session, if any, so
// the read side matches whichever directory the write side used.
function existingStateFile(sessionId) {
  const fileName = sessionFileName(sessionId);
  for (const d of stateDirs()) {
    const file = path.join(d.dir, fileName);
    try {
      // Checks only; creates nothing, so a working CLAUDE_PLUGIN_DATA never
      // leaves an empty temp directory behind.
      if (![...d.checked, d.dir].every(isOwnDir)) continue;
      fs.lstatSync(file);
      return file;
    } catch (_) {
      // Missing or unsafe; try the next one.
    }
  }
  return null;
}

// Records `names` and returns true, or returns false if nothing could be
// written. The hook denies only after a successful write, so a retry is
// always recognised.
function recordNames(sessionId, names) {
  const fileName = sessionFileName(sessionId);
  for (const d of stateDirs()) {
    try {
      const dir = ensureDir(d);
      const file = path.join(dir, fileName);
      const known = readState(file);
      if (known === null) continue;
      const fresh = names.filter((n) => !known.has(n));
      if (!fresh.length) return { written: true, fresh };
      // O_NOFOLLOW: never append through a symlink planted as the state file.
      const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(file, flags, 0o600);
      try { fs.writeSync(fd, fresh.join('\n') + '\n'); } finally { fs.closeSync(fd); }
      prune(dir, fileName);
      return { written: true, fresh };
    } catch (_) {
      // Try the next directory.
    }
  }
  return { written: false, fresh: [] };
}

// Deletes other sessions' files untouched for a day. A live session's file
// is touched whenever it lets a known name through, so only idle sessions
// age out. It runs only when the hook denies, which is rare, so the readdir
// cost stays off the common path. It removes only regular files whose names
// look like session files.
function prune(dir, keep) {
  try {
    const cutoff = Date.now() - DAY_MS;
    for (const f of fs.readdirSync(dir)) {
      if (f === keep || !SESSION_FILE_RE.test(f)) continue;
      try {
        const p = path.join(dir, f);
        const st = fs.lstatSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* another session may have removed it */ }
    }
  } catch (_) { /* pruning is best effort */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function reasonText(names) {
  // Factual statements, not instructions: the hooks docs warn that imperative
  // text in hook output can read like a prompt injection.
  return 'GreenFlagged plugin: this install was paused once so the packages can be checked. ' +
    `Packages: ${names.join(', ')}. ` +
    'Checking them with the GreenFlagged check_package or audit_manifest tool, then re-running the same command, proceeds. ' +
    'A command that only re-runs the same package names is not paused again. ' +
    'If the GreenFlagged tools are unavailable, re-running the command still proceeds. ' +
    'If this project\'s npm registry is GreenFlagged (registry=https://greenflagged.dev/npm/), unreviewed packages fail to install; otherwise nothing stops them.';
}

function decide(input) {
  const command = input && input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || !command) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

  const names = packagesIn(command, cwd);
  if (!names.length) return null;

  const file = existingStateFile(input.session_id);
  if (file !== null) {
    const known = readState(file);
    if (known === null) return null;
    if (names.every((n) => known.has(n))) {
      // Keep a live session's file from being pruned as idle.
      try { const now = new Date(); fs.utimesSync(file, now, now); } catch (_) { /* best effort */ }
      return null;
    }
  }

  const { written, fresh } = recordNames(input.session_id, names);
  if (!written || !fresh.length) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonText(names),
    },
  };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const out = decide(JSON.parse(raw));
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    } catch (_) {
      // Fail open: no output allows the command.
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { packagesIn, registryName, splitSegments };
