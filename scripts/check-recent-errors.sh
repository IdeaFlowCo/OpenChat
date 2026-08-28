#!/bin/bash
# check-recent-errors.sh — pull the last N minutes of error logs from prod
# openchat container. Used as the "did anything blow up?" probe so Claude
# can proactively spot 500s instead of waiting for Jacob to report them.
#
# Usage:
#   ./scripts/check-recent-errors.sh          # last 30 min, all sources
#   ./scripts/check-recent-errors.sh 2h       # last 2 hours
#   ./scripts/check-recent-errors.sh 30m api  # 30 min, api/backend only
#   ./scripts/check-recent-errors.sh 1h frontend  # 1 hour, mobile/web only
#
# Source filtering:
#   - 'api'      → server-side errors (console.error, throw, 500)
#   - 'frontend' → mobile + web client errors (level=error in JSON logs)
#   - 'all'      → both (default)

set -e

SINCE="${1:-30m}"
SOURCE="${2:-all}"

echo "═══ openchat errors — last $SINCE — source: $SOURCE ═══"

GCP_PROJECT="${GCP_PROJECT:-lightsail-migration}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_INSTANCE="${GCP_INSTANCE:-noos}"

LOGS=$(gcloud compute ssh "$GCP_INSTANCE" \
  --project="$GCP_PROJECT" \
  --zone="$GCP_ZONE" \
  --quiet \
  --command="sudo docker logs openchat_app --since $SINCE 2>&1" 2>/dev/null)

case "$SOURCE" in
  api)
    # Server-side: lines with 'error' or '500' that aren't JSON-shaped
    # frontend logs (those start with { and have 'source':'frontend').
    echo "$LOGS" | grep -iE "error|500|exception|stack|throw" | grep -v '"source":"frontend"' | tail -50
    ;;
  frontend)
    # Frontend logs are JSON; filter by level=error.
    echo "$LOGS" | grep -E '"source":"frontend"' | grep -E '"level":"(error|warn)"' | tail -30 \
      | while IFS= read -r line; do
          python3 -c "
import json,sys
try:
    d = json.loads('''$line''')
    print(f\"[{d.get('timestamp','?')}] [{d.get('level','?')}] {d.get('message','?')}\")
    err = d.get('error')
    if err:
        print(f\"    {err.get('name','Error')}: {err.get('message','?')}\")
        stack = err.get('stack', '')
        if stack:
            for s in stack.split(chr(10))[:3]:
                print(f\"    {s}\")
except Exception as e:
    print(f'(parse failed: $line)')" 2>/dev/null
        done
    ;;
  all|*)
    bash "$0" "$SINCE" api
    echo ""
    bash "$0" "$SINCE" frontend
    ;;
esac
