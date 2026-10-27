#!/usr/bin/env bash
set -euo pipefail

# Free Render web instances do not have a pre-deploy command. Complete setup before either child starts.
npm run db:migrate
npm run db:harden

api_pid=''
worker_pid=''
stop_children() {
  trap - TERM INT EXIT
  for child_pid in "$api_pid" "$worker_pid"; do
    if [[ -n "$child_pid" ]]; then kill -TERM "$child_pid" 2>/dev/null || true; fi
  done
  wait "$api_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
}
trap stop_children EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

node dist/main.js &
api_pid=$!
node dist/worker-main.js &
worker_pid=$!

set +e
wait -n "$api_pid" "$worker_pid"
status=$?
set -e
# A child ending unexpectedly must restart the complete service, including when it exits zero.
if [[ "$status" -eq 0 ]]; then status=1; fi
exit "$status"
