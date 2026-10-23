#!/bin/sh
# Fixture tests for the GreenFlagged plugin hooks. No dependencies beyond
# sh and node. Run from anywhere: sh hooks/test.sh
#
# Each case feeds hook input JSON to pre-install-check.sh, the same way
# Claude Code does, and checks whether a deny came back.

set -u

HOOKS=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HOOKS")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gf-hook-test.XXXXXX")
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

PROJECT="$WORK/project"
mkdir -p "$PROJECT"
pass=0
fail=0

# A fresh state directory, so a case does not see an earlier case's pauses.
fresh() {
  DATA=$(mktemp -d "$WORK/data.XXXXXX")
  TMPSTATE=$(mktemp -d "$WORK/tmp.XXXXXX")
}

# hook_input <command> [session_id] [cwd]: the JSON Claude Code sends.
# Built with node, so commands may hold quotes, backslashes and newlines.
hook_input() {
  CMD=$1 SID=${2:-session-a} DIR=${3:-$PROJECT} node -e '
    process.stdout.write(JSON.stringify({
      session_id: process.env.SID, transcript_path: "/dev/null", cwd: process.env.DIR,
      hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: process.env.CMD } }));'
}

# run_hook <command> [session_id] [cwd]
run_hook() {
  hook_input "$@" |
    CLAUDE_PLUGIN_DATA="$DATA" CLAUDE_PLUGIN_ROOT="$ROOT" TMPDIR="$TMPSTATE" \
    sh "$HOOKS/pre-install-check.sh"
}

ok() { pass=$((pass + 1)); }
ko() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1"; [ -n "${2:-}" ] && printf '  output: %s\n' "$2"; }

# expect_deny <description> <output> [substring...]
expect_deny() {
  desc=$1; out=$2; shift 2
  case "$out" in
    *'"permissionDecision":"deny"'*) ;;
    *) ko "$desc (expected deny)" "$out"; return ;;
  esac
  for want in "$@"; do
    case "$out" in
      *"$want"*) ;;
      *) ko "$desc (reason lacks '$want')" "$out"; return ;;
    esac
  done
  ok
}

# expect_silent <description> <output>
expect_silent() {
  if [ -z "$2" ]; then ok; else ko "$1 (expected no output)" "$2"; fi
}

deny_once() {
  fresh
  expect_deny "$1" "$(run_hook "$1")" ${2:+"$2"}
}

allow_fresh() {
  fresh
  expect_silent "$1" "$(run_hook "$1")"
}

# --- deny once, then allow -------------------------------------------------
fresh
expect_deny 'npm install lodash' "$(run_hook 'npm install lodash')" 'lodash' 'check_package'
expect_silent 'same command again is allowed' "$(run_hook 'npm install lodash')"
expect_deny 'a new name after a paused one' "$(run_hook 'npm install lodash express')" 'express' 'lodash'
expect_silent 'flag-only change is allowed' "$(run_hook 'npm install -D --save-exact lodash express')"
expect_deny 'a different session pauses again' "$(run_hook 'npm install lodash' session-b)" 'lodash'
expect_silent 'version change of a known name is allowed' "$(run_hook 'npm i lodash@4.17.21')"

# --- named installs and fetch-and-run forms --------------------------------
deny_once 'npm i -D vitest' 'vitest'
deny_once 'npm install @scope/pkg@^1.2' '@scope/pkg'
deny_once 'pnpm add react' 'react'
deny_once 'pnpm add -w react' 'react'
deny_once 'yarn add left-pad' 'left-pad'
deny_once 'bun add left-pad' 'left-pad'
deny_once 'npx create-foo' 'create-foo'
deny_once 'npx -y -p typescript tsc --init' 'typescript'
deny_once 'npm exec -- cowsay hi' 'cowsay'
deny_once 'pnpm dlx create-vite' 'create-vite'
deny_once 'yarn dlx create-vite' 'create-vite'
deny_once 'bunx cowsay' 'cowsay'
deny_once 'bun x cowsay' 'cowsay'
deny_once 'cd app && npm install left-pad' 'left-pad'
deny_once 'npm --prefix app install left-pad' 'left-pad'
deny_once 'npm install -w pkgs/foo lodash' 'lodash'
deny_once 'pnpm --filter foo add left-pad' 'left-pad'
deny_once 'yarn workspace foo add left-pad' 'left-pad'
deny_once 'npm install-test left-pad' 'left-pad'
deny_once 'FOO=1 sudo npm i -g left-pad' 'left-pad'
deny_once 'npm ci && npm install left-pad 2>&1 | tail -5' 'left-pad'

# Initialisers fetch create-<name>.
deny_once 'npm create vite@latest my-app' 'Packages: create-vite.'
deny_once 'npm init foo' 'Packages: create-foo.'
deny_once 'yarn create next-app' 'Packages: create-next-app.'
deny_once 'pnpm create @vue' 'Packages: @vue/create.'
deny_once 'bun create @scope/x' 'Packages: @scope/create-x.'
allow_fresh 'npm init -y'

# Wrapper commands in front of the package manager.
deny_once 'timeout -k 5 60 npm i left-pad' 'Packages: left-pad.'
deny_once 'nohup npm i left-pad' 'Packages: left-pad.'
deny_once 'nice -n 10 npm i left-pad' 'Packages: left-pad.'
deny_once 'env -u FOO npm i left-pad' 'Packages: left-pad.'
deny_once '/usr/bin/env npm i left-pad' 'Packages: left-pad.'
deny_once 'npm isnt left-pad' 'Packages: left-pad.'

# Shell -c strings are inspected.
deny_once 'bash -c "npm i left-pad && pnpm add is-odd"' 'Packages: left-pad, is-odd.'
deny_once "sh -ec 'npx cowsay hi'" 'Packages: cowsay.'

# Aliases name their target; value flags are not packages.
deny_once 'npm i lodash@npm:lodash-es@4' 'Packages: lodash-es.'
deny_once 'npx --loglevel silly cowsay' 'Packages: cowsay.'
deny_once 'npm i --loglevel verbose lodash' 'Packages: lodash.'

# Specs with no registry name fetch nothing from the registry.
allow_fresh 'npm i ./local.tgz'
allow_fresh 'npm i .'
allow_fresh 'npm i file:../foo'
allow_fresh 'npm i https://example.com/y.tgz'
allow_fresh 'npm i user/repo'
allow_fresh 'npx @a/../../zzfile'

# Heredoc bodies are data, not commands.
allow_fresh "$(printf 'cat <<EOF > notes.md\nnpm install lodash\nEOF')"
allow_fresh "$(printf "cat <<-'X' > f\n\tnpm i lodash\n\tX\necho ok")"
deny_once "$(printf 'cat <<EOF > notes.md\nnpm install lodash\nEOF\nnpm i left-pad')" 'Packages: left-pad.'

# A heredoc fed to a shell is a script, so its body is inspected.
deny_once "$(printf 'bash <<EOF\nnpm i left-pad\nEOF')" 'Packages: left-pad.'
deny_once "$(printf "ssh host <<'X'\nnpm i left-pad\nX")" 'Packages: left-pad.'
deny_once "$(printf 'cat <<EOF | sh\nnpm i left-pad\nEOF')" 'Packages: left-pad.'

# `<<` inside arithmetic is not a heredoc. Mid-word it is, as in bash:
# `cat<<EOF` is `cat <<EOF`, and the rest of its line still runs.
deny_once "$(printf 'echo $((1<<2))\nnpm i left-pad')" 'Packages: left-pad.'
deny_once 'x=a<<b; npm i left-pad' 'Packages: left-pad.'
allow_fresh "$(printf 'cat<<EOF\nnpm install lodash\nEOF')"
deny_once "$(printf "cat<<'EOF' > notes.txt\nit's fine\nEOF\nnpm i left-pad")" 'Packages: left-pad.'
# `$((cmd) && ...)` is a subshell in a command substitution, not arithmetic.
deny_once 'echo $((echo hi) && npm i left-pad)' 'Packages: left-pad.'

# `#` inside a word (a URL fragment) is not a comment.
deny_once 'npm i https://github.com/a/b#ref && npm i left-pad' 'Packages: left-pad.'

# Comments are not package names.
allow_fresh 'npm install # install deps'
allow_fresh 'pnpm install # frozen'
deny_once 'npm i left-pad # why' 'Packages: left-pad.'
deny_once 'yarn add left-pad # for padding' 'Packages: left-pad.'

# More value flags and nested forms.
deny_once 'npm i --audit-level high left-pad' 'Packages: left-pad.'
deny_once 'bun add --filter foo left-pad' 'Packages: left-pad.'
deny_once 'npm i pkg@workspace:* left-pad' 'Packages: left-pad.'
allow_fresh 'pnpm add pkg@workspace:*'
deny_once 'bash -o pipefail -c "npm i left-pad"' 'Packages: left-pad.'
deny_once 'npx -c "npm i left-pad"' 'Packages: left-pad.'

# Value-taking flags must not be read as package names.
fresh
out=$(run_hook 'npm --prefix app install left-pad')
case "$out" in *'Packages: left-pad.'*) ok ;; *) ko 'npm --prefix value is not a package' "$out" ;; esac
fresh
out=$(run_hook 'npm install -w pkgs/foo lodash')
case "$out" in *'Packages: lodash.'*) ok ;; *) ko 'npm -w value is not a package' "$out" ;; esac

# npx runs a local binary without fetching, so no pause.
mkdir -p "$PROJECT/node_modules/.bin"
: > "$PROJECT/node_modules/.bin/vitest"
allow_fresh 'npx vitest run'
deny_once 'pnpm dlx vitest' 'vitest'

# --- commands that never pause ---------------------------------------------
allow_fresh 'npm install'
allow_fresh 'npm i'
allow_fresh 'npm ci'
allow_fresh 'npm clean-install'
allow_fresh 'pnpm install --frozen-lockfile'
allow_fresh 'pnpm install'
allow_fresh 'yarn'
allow_fresh 'yarn install --immutable'
allow_fresh 'bun install'
allow_fresh 'npm run build'
allow_fresh 'npm test'
allow_fresh 'ls -la'
allow_fresh 'echo bundle'
: > "$PROJECT/package.json"
: > "$PROJECT/package-lock.json"
allow_fresh 'npm install'

# --- failure paths: always exit 0, never a deny ---------------------------
fresh
out=$(printf 'not json npm' | CLAUDE_PLUGIN_DATA="$DATA" sh "$HOOKS/pre-install-check.sh"); rc=$?
if [ $rc -eq 0 ] && [ -z "$out" ]; then ok; else ko "malformed JSON (rc=$rc)" "$out"; fi

if [ "$(id -u)" != 0 ]; then
  # Root ignores file modes, so this case only means something as a user.
  fresh
  chmod 500 "$DATA" "$TMPSTATE"
  expect_silent 'unwritable state allows' "$(run_hook 'npm install lodash')"
  chmod 700 "$DATA" "$TMPSTATE"
fi

if [ ! -x /usr/bin/node ] && [ ! -x /bin/node ]; then
  out=$(printf '{"tool_input":{"command":"npm install lodash"}}' |
    env PATH=/usr/bin:/bin HOME=/nonexistent NVM_DIR=/nonexistent sh "$HOOKS/pre-install-check.sh"); rc=$?
  if [ $rc -eq 0 ] && [ -z "$out" ]; then ok; else ko "no node (rc=$rc)" "$out"; fi
fi

fresh
out=$(hook_input 'npm install lodash' s |
  env -u CLAUDE_PLUGIN_ROOT CLAUDE_PLUGIN_DATA="$DATA" TMPDIR="$TMPSTATE" sh "$HOOKS/pre-install-check.sh")
expect_deny 'CLAUDE_PLUGIN_ROOT unset still works' "$out" 'lodash'

# CLAUDE_PLUGIN_DATA unset falls back to TMPDIR, and retries still pass.
fresh
out=$(hook_input 'npm install lodash' s |
  env -u CLAUDE_PLUGIN_DATA TMPDIR="$TMPSTATE" sh "$HOOKS/pre-install-check.sh")
expect_deny 'CLAUDE_PLUGIN_DATA unset denies via TMPDIR' "$out" 'lodash'
out=$(hook_input 'npm install lodash' s |
  env -u CLAUDE_PLUGIN_DATA TMPDIR="$TMPSTATE" sh "$HOOKS/pre-install-check.sh")
expect_silent 'CLAUDE_PLUGIN_DATA unset retry allows' "$out"

# --- pruning ---------------------------------------------------------------
fresh
mkdir -p "$DATA/sessions"
: > "$DATA/sessions/old-session"
touch -t 200001010000 "$DATA/sessions/old-session"
: > "$DATA/sessions/recent-session"
run_hook 'npm install lodash' >/dev/null
if [ ! -e "$DATA/sessions/old-session" ]; then ok; else ko 'a day-old session file is pruned'; fi
if [ -e "$DATA/sessions/recent-session" ]; then ok; else ko 'a recent session file is kept'; fi

# Pruning removes only regular files named like session files.
fresh
mkdir -p "$DATA/sessions"
: > "$WORK/victim"
touch -t 200001010000 "$WORK/victim"
ln -s "$WORK/victim" "$DATA/sessions/linked-session"
touch -h -t 200001010000 "$DATA/sessions/linked-session"
: > "$DATA/sessions/not.a.session"
touch -t 200001010000 "$DATA/sessions/not.a.session"
run_hook 'npm install lodash' >/dev/null
if [ -e "$WORK/victim" ] && [ -L "$DATA/sessions/linked-session" ]; then ok; else ko 'prune leaves symlinks alone'; fi
if [ -e "$DATA/sessions/not.a.session" ]; then ok; else ko 'prune leaves non-session names alone'; fi

# A live session's file is touched when a known name passes, so a session
# idle for over a day keeps its record while it is still being used.
fresh
run_hook 'npm install lodash' >/dev/null
touch -t 200001010000 "$DATA/sessions/session-a"
expect_silent 'known name passes after a day' "$(run_hook 'npm install lodash')"
run_hook 'npm install left-pad' session-b >/dev/null
expect_silent 'touched session survives another session pruning' "$(run_hook 'npm install lodash')"

# The temp fallback refuses a symlinked or foreign directory.
fresh
mkdir -p "$WORK/elsewhere"
ln -s "$WORK/elsewhere" "$TMPSTATE/greenflagged-plugin-$(id -u)"
out=$(hook_input 'npm install lodash' | env -u CLAUDE_PLUGIN_DATA TMPDIR="$TMPSTATE" sh "$HOOKS/pre-install-check.sh")
expect_silent 'symlinked temp state dir allows' "$out"
if [ -z "$(ls -A "$WORK/elsewhere")" ]; then ok; else ko 'nothing written through the symlink'; fi
fresh
out=$(hook_input 'npm install lodash' | env -u CLAUDE_PLUGIN_DATA TMPDIR="$TMPSTATE" sh "$HOOKS/pre-install-check.sh")
mode=$(ls -ld "$TMPSTATE/greenflagged-plugin-$(id -u)" | cut -c1-10)
if [ "$mode" = drwx------ ]; then ok; else ko "temp state dir is 0700 (got $mode)"; fi

# A working CLAUDE_PLUGIN_DATA leaves no temp directory behind.
fresh
run_hook 'npm install lodash' >/dev/null
run_hook 'npm install lodash' >/dev/null
if [ ! -e "$TMPSTATE/greenflagged-plugin-$(id -u)" ]; then ok; else ko 'no temp dir when CLAUDE_PLUGIN_DATA works'; fi

# A symlink planted as the state file is never written through.
fresh
mkdir -p "$DATA/sessions"
: > "$WORK/target"
ln -s "$WORK/target" "$DATA/sessions/session-a"
expect_silent 'symlinked state file allows' "$(run_hook 'npm install lodash')"
if [ ! -s "$WORK/target" ]; then ok; else ko 'nothing written through a symlinked state file'; fi

# --- SessionStart ----------------------------------------------------------
out=$(sh "$HOOKS/session-start.sh" </dev/null)
if printf '%s' "$out" | node -e '
  const o = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.exit(o.hookSpecificOutput.hookEventName === "SessionStart" &&
    o.hookSpecificOutput.additionalContext.length > 0 ? 0 : 1);'; then ok; else ko 'session-start.sh prints SessionStart JSON' "$out"; fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
