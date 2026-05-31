#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
xvfb_log="/tmp/verizon-xvfb.log"

Xvfb "$DISPLAY" -screen 0 1280x720x24 -ac -nolisten tcp >"$xvfb_log" 2>&1 &
xvfb_pid=$!

cleanup() {
  kill "$xvfb_pid" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

sleep 1

if ! kill -0 "$xvfb_pid" >/dev/null 2>&1; then
  echo "Xvfb failed to start. Log output:" >&2
  cat "$xvfb_log" >&2
  exit 1
fi

"$@"
