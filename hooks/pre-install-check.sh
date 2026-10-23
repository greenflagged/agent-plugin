#!/bin/sh
# PreToolUse hook (matcher: Bash) for the GreenFlagged plugin.
#
# This wrapper finds node and hands the hook input to pre-install-check.js,
# which decides whether to pause the command. The wrapper exists so the
# common case stays cheap: most Bash commands never mention a package
# manager, and those exit here without starting node.
#
# The hook fails open. It always exits 0, and any error means no output,
# which Claude Code treats as "allow". A broken hook must never block a
# user's shell. Exit 2 would block, so it is never used.

input=$(cat) || exit 0

# Cheap prefilter. Only input that mentions a package manager goes on to node.
# It matches the whole hook JSON, not just the command, so a working directory
# whose path contains "npm", "bun" or "yarn" sends every Bash call to node.
# "*bun*" also matches words like "bundle". A false hit costs one node spawn.
case "$input" in
  *npm*|*npx*|*pnpm*|*yarn*|*bun*|*dlx*) ;;
  *) exit 0 ;;
esac

root=${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}

# Hook processes may not inherit an interactive shell's PATH, so fall back to
# an nvm-installed node (the last one the glob lists). With no node we allow:
# a standalone pnpm or bun install without node gets no pause.
node=$(command -v node 2>/dev/null)
if [ -z "$node" ]; then
  for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node; do
    [ -x "$candidate" ] && node=$candidate
  done
fi
[ -n "$node" ] || exit 0

printf '%s' "$input" | "$node" "$root/hooks/pre-install-check.js" 2>/dev/null || true
exit 0
