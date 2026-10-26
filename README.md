# Greenflagged plugin for Claude Code

[Greenflagged](https://greenflagged.dev) is an npm registry that serves only
packages that passed automated security analysis and review. This plugin lets
Claude Code check a package before it installs it.

## Install

Inside Claude Code:

```
/plugin marketplace add greenflagged/agent-plugin
/plugin install greenflagged@greenflagged
```

Restart Claude Code, run `/mcp`, choose the Greenflagged server, and sign in
through your browser. There is no token to copy.

If you added the Greenflagged MCP server by hand before, remove it with
`claude mcp remove greenflagged`, so the agent does not see every tool twice.

## Point npm at the registry

The plugin does not change where npm installs from. npm needs its own token.
Mint one at <https://greenflagged.dev/account/tokens>, export it in your shell
profile, and add two lines to `~/.npmrc`:

```sh
export GREENFLAGGED_TOKEN=gflag_...
```

```ini
registry=https://greenflagged.dev/npm/
//greenflagged.dev/npm/:_authToken=${GREENFLAGGED_TOKEN}
```

Keep the auth line in `~/.npmrc`, because pnpm ignores `${...}` in a project's
`.npmrc`. If the variable is unset, npm reports a generic `E401`.

## What's in the plugin

- **The Greenflagged tools**, such as `check_package` and `audit_manifest`.
- **The `greenflagged-deps` skill**, which tells the agent when to use them.
- **A pre-install hook.** It pauses the first install of each new package name
  once per session, so the agent checks the package first. Re-running the same
  command then goes through.

The hook is a pause, not a gate, and it makes no network calls. What blocks an
unreviewed package is npm installing from Greenflagged. The hook matches common
command shapes (`npm install x`, `npx x`, `pnpm add x` and similar), so it
misses an install hidden in a script or a variable. It also never pauses a bare
`npm install`. If you edit `package.json` by hand, ask the agent to run
`audit_manifest` first.

## CI and headless machines

A machine with no browser cannot sign in. Give it its own token from
<https://greenflagged.dev/account/tokens> and add the server by hand:

```sh
claude mcp add --transport http greenflagged https://greenflagged.dev/mcp \
  --header "Authorization: Bearer $GREENFLAGGED_TOKEN"
```

Claude Code stores that token in plain text in `~/.claude.json`. Never use
`--scope project`, and never commit an `.mcp.json` with a token in it.

## Updating

Claude Code does not auto-update marketplaces other than Anthropic's. Update by
hand, or turn auto-update on under `/plugin` → Marketplaces:

```
/plugin marketplace update greenflagged
/plugin update greenflagged@greenflagged
```

## Where does the source live?

This repo is a mirror, written by CI from Greenflagged's private source repo.
Please report bugs and ideas in this repo's
[issues](https://github.com/greenflagged/agent-plugin/issues). Pull requests
are welcome, and a maintainer applies them in the source repo.

The hook has no dependencies, on purpose: it uses only `sh` and node's standard
library. `sh hooks/test.sh` runs its fixtures.

## License

MIT. See [LICENSE](LICENSE).
