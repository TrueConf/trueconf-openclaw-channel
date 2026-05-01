#!/usr/bin/env bash
# L1b at-least-once outbound: end-to-end docker scenario.
#
# Flow:
#   1. compose up -- two containers (fake-server + plugin) on a shared bridge.
#   2. Plugin connects, auths, sends batch1 (3 msgs) -- all OK.
#   3. After batch1_done, driver POSTs /control/dropAll -- the server
#      terminates the open WS but keeps listening for reconnects.
#   4. Plugin's lifecycle.onDisconnected callback submits batch2 (5 msgs)
#      synchronously inside the close handler. Each submit hits the
#      WS-not-connected throw path; OutboundQueue parks all 5 items.
#   5. lifecycle.scheduleReconnect succeeds on its 1s backoff, markAuthenticated
#      fires onAuth, OutboundQueue.drain() sends the 5 parked items and
#      resolves their promises.
#   6. Driver asserts: batch1Fulfilled=3, batch2Fulfilled=5,
#      server.messageRequests=8, server.authRequests>=2 (proves a real
#      reconnect happened rather than the WS surviving via TCP retransmit).
#   7. compose down.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PROJECT="docker-e2e"
NET="${PROJECT}_e2e"
PLUGIN_CT="${PROJECT}-plugin-1"
FAKE_CT="${PROJECT}-fake-server-1"

LOG_DIR="$(mktemp -d -t openclaw-e2e-XXXXXX)"
PLUGIN_LOG="$LOG_DIR/plugin.log"
FAKE_LOG="$LOG_DIR/fake-server.log"
echo "logs: $LOG_DIR"

cleanup() {
  echo "--- compose down ---"
  docker compose -f compose.yaml -p "$PROJECT" down --remove-orphans --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "--- compose up (build) ---"
docker compose -f compose.yaml -p "$PROJECT" up --build -d --force-recreate

# Stream container logs to files so we can grep for events without blocking.
docker compose -f compose.yaml -p "$PROJECT" logs -f --no-color --no-log-prefix plugin > "$PLUGIN_LOG" 2>&1 &
LOGS_PID=$!
docker compose -f compose.yaml -p "$PROJECT" logs -f --no-color --no-log-prefix fake-server > "$FAKE_LOG" 2>&1 &
FAKE_LOGS_PID=$!

wait_for_event() {
  local event="$1"
  local timeout="${2:-30}"
  local start=$SECONDS
  while (( SECONDS - start < timeout )); do
    if grep -F "\"event\":\"$event\"" "$PLUGIN_LOG" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "timeout waiting for plugin event: $event ($timeout s)" >&2
  echo "--- plugin tail ---" >&2; tail -50 "$PLUGIN_LOG" >&2 || true
  echo "--- fake-server tail ---" >&2; tail -50 "$FAKE_LOG" >&2 || true
  return 1
}

control_state() {
  docker exec "$FAKE_CT" curl -fsS "http://localhost:4310/control/state"
}

drop_all() {
  docker exec "$FAKE_CT" curl -fsS -X POST "http://localhost:4310/control/dropAll" >/dev/null
}

echo "--- waiting for plugin lifecycle_started ---"
wait_for_event "lifecycle_started" 60

echo "--- waiting for plugin batch1_done ---"
wait_for_event "batch1_done" 15

echo "--- dropAll: server terminates open WS, keeps listening ---"
drop_all

echo "server state post-drop:"
control_state || true

echo "--- waiting for plugin batch2_submitted (fires inside onDisconnected) ---"
wait_for_event "batch2_submitted" 15

echo "--- waiting for plugin final ---"
wait_for_event "final" 60

# Stop log followers so the final log lines are deterministic in the file.
kill "$LOGS_PID" "$FAKE_LOGS_PID" 2>/dev/null || true
wait "$LOGS_PID" "$FAKE_LOGS_PID" 2>/dev/null || true

FINAL=$(grep -F "\"event\":\"final\"" "$PLUGIN_LOG" | tail -1)
echo "--- plugin final: $FINAL"

parse() { python3 -c "import sys,json;print(json.loads(sys.argv[1])[sys.argv[2]])" "$FINAL" "$1"; }
B1=$(parse batch1Fulfilled)
B2=$(parse batch2Fulfilled)

STATE=$(control_state)
echo "--- server state final: $STATE"
SERVER_MSGS=$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['messageRequests'])" "$STATE")
SERVER_AUTHS=$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['authRequests'])" "$STATE")

FAIL=0
if [ "$B1" != "3" ]; then echo "FAIL: batch1Fulfilled=$B1 expected 3"; FAIL=1; fi
if [ "$B2" != "5" ]; then echo "FAIL: batch2Fulfilled=$B2 expected 5"; FAIL=1; fi
if [ "$SERVER_MSGS" != "8" ]; then echo "FAIL: server messageRequests=$SERVER_MSGS expected 8"; FAIL=1; fi
# >=2 proves a real reconnect happened rather than the WS surviving the
# outage via TCP retransmit (which would let messages flow on auth #1).
if [ "$SERVER_AUTHS" -lt 2 ]; then echo "FAIL: server authRequests=$SERVER_AUTHS expected >=2 (real reconnect required)"; FAIL=1; fi

if [ "$FAIL" = "0" ]; then
  echo "--- L1b e2e PASS: batch1=3/3, batch2=5/5, server received 8/8, reconnects=$((SERVER_AUTHS-1)) ---"
else
  echo "--- L1b e2e FAIL ---"
  echo "--- plugin tail ---"; tail -80 "$PLUGIN_LOG"
  echo "--- fake-server tail ---"; tail -80 "$FAKE_LOG"
fi

exit $FAIL
