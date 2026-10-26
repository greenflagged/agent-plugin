# Greenflagged plugin for Claude Code

[Greenflagged](https://greenflagged.dev) is an npm registry that serves only
packages that passed automated security analysis and review. This plugin
connects Claude Code to it. It adds three things:

- **The Greenflagged MCP server.** The agent can ask whether a package is
  reviewed (`check_package`), audit a whole `package.json` (`audit_manifest`),
  and request an import (`request_package`).
- **The `greenflagged-deps` skill.** It tells the agent when to call those
  tools and how to read the answers.
- **A pre-install hook.** It pauses the first install of each new package name
  once per session, so the agent checks the package before installing it.

npm is covered today. PyPI support is planned.

## Install

Inside Claude Code:

```
/plugin marketplace add greenflagged/agent-plugin
/plugin install greenflagged@greenflagged
```

Then restart Claude Code.

If you added the Greenflagged MCP server by hand earlier, remove it first, so
the agent does not see two copies of every tool:

```
claude mcp remove greenflagged
```

## Sign in

The MCP server signs in through your browser. It needs no token.

1. Run `/mcp` inside Claude Code.
2. Choose the Greenflagged server.
3. Approve the request on the Greenflagged page that opens in your browser.

Claude Code keeps the sign-in and refreshes it. To disconnect, use
**Connected agents** at <https://greenflagged.dev/account/tokens>.

### CI and headless machines

A machine with no browser cannot sign in. Use a token instead. Mint one at
<https://greenflagged.dev/account/tokens>, just for that machine, so you can
revoke it alone. Export it as `GREENFLAGGED_TOKEN` (see
[Point npm at the registry](#point-npm-at-the-registry)), then add the server
by hand:

```sh
claude mcp add --transport http greenflagged https://greenflagged.dev/mcp \
  --header "Authorization: Bearer $GREENFLAGGED_TOKEN"
```

The variable keeps the token out of your shell history. The shell expands it
before Claude Code runs, though. Claude Code then stores the header, token
included, in plain text in `~/.claude.json`. Two rules follow:

- **Never use `--scope project`.** That writes the token into the project's
  `.mcp.json`.
- **Never commit an `.mcp.json` with a token in it.**

The tools from this server are named `mcp__greenflagged__…`, not
`mcp__plugin_greenflagged_greenflagged__…` as under the plugin. The skill
knows both names.

The plugin's own MCP server stays signed out there. Its skill and hook still
work.

## Point npm at the registry

The plugin does not change where npm installs from. npm needs a token of its
own, because signing in covers only the MCP server. Mint one at
<https://greenflagged.dev/account/tokens> and export it in your shell profile:

```sh
export GREENFLAGGED_TOKEN=gflag_...
```

Then add these two lines to `~/.npmrc`:

```ini
registry=https://greenflagged.dev/npm/
//greenflagged.dev/npm/:_authToken=${GREENFLAGGED_TOKEN}
```

The `registry=` line may instead go in a project's `.npmrc`. The auth line
must stay in `~/.npmrc`. Make that file readable only by you:
`chmod 600 ~/.npmrc`. More setup detail is at
<https://greenflagged.dev/account/mcp-setup> (sign-in required).

Two caveats about the auth line:

- **Keep it in `~/.npmrc`.** pnpm 11.5.3 and later ignore `${...}` references
  in a project-level `.npmrc` (see <https://pnpm.io/npmrc>).
- **Export the variable before running npm.** If it is unset, npm (checked
  on 10.9.2 and 10.9.9) sends the literal text `${GREENFLAGGED_TOKEN}`. The
  registry then
  answers with a generic `E401 token seems to be invalid`, which does not say
  the variable is missing.

## What the hook does

The hook runs before every Bash command the agent runs. It pauses these
command forms when they name a package that is new in this session:

- named installs: `npm install x`, `pnpm add x`, `yarn add x`, `bun add x`
- initialisers: `npm create x`, `npm init x`, `yarn`/`pnpm`/`bun create x`
  (these fetch `create-x`)
- fetch-and-run: `npx x`, `npm exec x`, `pnpm dlx x`, `yarn dlx x`, `bunx x`

It also sees through `sudo`, `env`, `timeout`, `nohup`, `cd dir &&`,
`bash -c "..."`, `npx -c "..."` and a heredoc fed to a shell
(`bash <<EOF`). It is a pattern match over common shapes, not a shell
parser. An install hidden in a script file, a variable or `$(...)` is
missed.

The pause is a one-time deny. Claude Code shows the agent a short reason that
names the packages and the Greenflagged tools. The agent checks the packages,
re-runs the same command, and the command proceeds. Each package name pauses
once per session. `npm i a b` after a paused `npm i a` pauses once more, for
`b`.

"Once per session" has one exception. Session records untouched for a day
are deleted, so a session left idle for over a day may see a pause again.

The hook never pauses:

- bare installs: `npm install`, `npm ci`, `pnpm install --frozen-lockfile`,
  `yarn`
- `npx x` when `node_modules/.bin/x` already exists, since npx fetches nothing
- local paths, tarballs, URLs and git specs (`npm i ./pkg`, `npm i user/repo`),
  which have no registry name to check
- text inside a heredoc that is not fed to a shell (`cat <<EOF > notes.md`)
- `#` comments, and `workspace:` / `link:` specs
- anything when node is not installed, or when the hook hits any error

**Accepted gap.** If you edit `package.json` by hand and then run a bare
`npm install`, the hook does not pause. Ask the agent to run `audit_manifest`
first.

The hook makes no network calls. It is a pause, not a gate: an agent can
always route around it. What stops an unreviewed package is npm installing
from Greenflagged (set up above). A package with no reviewed version fails to
install there. If npm points anywhere else, nothing stops it.

The hook records the names it has paused on in one small file per session,
under the plugin's data directory (`~/.claude/plugins/data/...`). A file
untouched for a day is deleted the next time the hook pauses.

A second, session-start hook adds one sentence to the agent's context, so the
first pause is expected rather than surprising.

## Updating

Claude Code leaves auto-update off for marketplaces other than Anthropic's.
Update by hand:

```
/plugin marketplace update greenflagged
/plugin update greenflagged@greenflagged
```

Or turn auto-update on under `/plugin` → Marketplaces.

Earlier versions of the plugin sent `GREENFLAGGED_TOKEN` as a header to the
MCP server. This version does not. After updating, sign in once (see
[Sign in](#sign-in)). Keep `GREENFLAGGED_TOKEN` exported if npm uses it.

## Where does the source live?

This GitHub repo is a mirror, written by CI from Greenflagged's private
source repo. Every sync overwrites it.

Please report bugs and ideas in this repo's
[issues](https://github.com/greenflagged/agent-plugin/issues). Pull requests
are welcome too. They are not merged here, because the next sync would
overwrite them. A maintainer applies the change in the source repo instead.

This repo has no `package.json` and no `node_modules`, on purpose. The hook
uses only `sh` and node's standard library. A plugin that guards installs
should not need dependencies of its own. `sh hooks/test.sh` runs the hook
fixtures.

**For maintainers:** to check that this mirror matches the source repo's
`main`, run this in a checkout of the source repo. Equal tree hashes mean identical files
and modes.

```sh
git fetch -q origin main && git fetch -q https://github.com/greenflagged/agent-plugin.git main &&
  [ "$(git rev-parse FETCH_HEAD^{tree})" = "$(git rev-parse origin/main:agent-plugin)" ] &&
  echo in sync || echo DRIFT
```

## License

MIT. See [LICENSE](LICENSE).
