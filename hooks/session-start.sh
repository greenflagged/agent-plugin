#!/bin/sh
# SessionStart hook for the Greenflagged plugin.
#
# It tells the agent, once per session start, that the pre-install hook will
# pause the first install of each new package name. Without this note a deny
# arrives unexplained, and agents tend to retry blindly or route around it.
# The text is 33 words, an estimated 45-50 tokens per session start (counted
# by word length, not measured with a tokenizer, 2026-10-20).
#
# No node, no state, no network. It always exits 0.
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Greenflagged plugin pauses the first Bash install of each new npm package name once per session. Checking the package with the Greenflagged check_package or audit_manifest tool and re-running the same command proceeds."}}'
exit 0
