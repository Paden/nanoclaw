#!/bin/bash
#
# Audit tool-call logs for sheets.mjs heredoc patterns. Fix #4 (commit 5a7dcc5)
# removed docs teaching the agent to call sheets.mjs via `node -e` / `node
# --input-type=module` heredocs, which pipe unbounded JSON into context. This
# script checks whether agents still use that pattern after the fix.
#
# Usage:  ./scripts/audit-sheets-heredocs.sh [CUTOFF_ISO]
#
# CUTOFF_ISO defaults to 2026-04-20T16:20:00Z (Fix #4 landing, UTC). Hits split
# into pre-cutoff (baseline) and post-cutoff (regression signal). Exits 0 if
# no post-cutoff hits, 1 otherwise — suitable for cron wrapping.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CUTOFF="${1:-2026-04-20T16:20:00Z}"

PATTERN='node -e|node --input-type=module|sheets\.mjs'

printf 'Audit cutoff: %s\n' "$CUTOFF"
printf 'Pattern:      %s\n\n' "$PATTERN"

printf '%-30s %10s %10s\n' 'group' 'pre-cutoff' 'post-cutoff'
printf '%-30s %10s %10s\n' '------------------------------' '----------' '-----------'

total_post=0
for f in "$PROJECT_ROOT"/groups/*/logs/tool-calls.jsonl; do
  [ -f "$f" ] || continue
  group=$(basename "$(dirname "$(dirname "$f")")")

  read -r pre post < <(
    awk -F'"t":"' -v cutoff="$CUTOFF" -v pat="$PATTERN" '
      $0 ~ pat {
        split($2, a, "\"")
        if (a[1] < cutoff) pre++
        else post++
      }
      END { print (pre ? pre : 0), (post ? post : 0) }
    ' "$f"
  )

  if [ "$pre" -gt 0 ] || [ "$post" -gt 0 ]; then
    printf '%-30s %10s %10s\n' "$group" "$pre" "$post"
  fi
  total_post=$((total_post + post))
done

echo
if [ "$total_post" -eq 0 ]; then
  echo "OK: no post-cutoff hits."
  exit 0
else
  echo "REGRESSION: $total_post post-cutoff hit(s). Sample:"
  for f in "$PROJECT_ROOT"/groups/*/logs/tool-calls.jsonl; do
    [ -f "$f" ] || continue
    group=$(basename "$(dirname "$(dirname "$f")")")
    awk -F'"t":"' -v cutoff="$CUTOFF" -v pat="$PATTERN" -v grp="$group" '
      $0 ~ pat {
        split($2, a, "\"")
        if (a[1] >= cutoff) {
          print grp ": " substr($0, 1, 200)
        }
      }
    ' "$f"
  done | head -10
  exit 1
fi
