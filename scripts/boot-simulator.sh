#!/bin/bash
# Boot iOS Simulator with timeout and retry.
# Workaround for "Waiting on BackBoard" hang on CI.
#
# Usage: ./scripts/boot-simulator.sh <UDID>

set -euo pipefail

UDID="$1"
TIMEOUT=120  # seconds
MAX_RETRIES=3

for attempt in $(seq 1 $MAX_RETRIES); do
  xcrun simctl bootstatus "$UDID" -b &
  BOOT_PID=$!

  # Wait up to TIMEOUT seconds
  ELAPSED=0
  while kill -0 "$BOOT_PID" 2>/dev/null; do
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "Boot attempt $attempt timed out after ${TIMEOUT}s, retrying..."
      kill "$BOOT_PID" 2>/dev/null || true
      wait "$BOOT_PID" 2>/dev/null || true
      xcrun simctl shutdown "$UDID" 2>/dev/null || true
      sleep 2
      break
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
  done

  # Check if boot succeeded (device is Booted)
  STATE=$(xcrun simctl list devices -j | jq -r --arg udid "$UDID" '.devices | to_entries[] | .value[] | select(.udid == $udid) | .state')
  if [ "$STATE" = "Booted" ]; then
    exit 0
  fi
done

echo "ERROR: Failed to boot simulator after $MAX_RETRIES attempts" >&2
exit 1
