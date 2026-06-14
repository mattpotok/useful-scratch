#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
xvfb_log="/tmp/verizon-xvfb.log"

Xvfb "$DISPLAY" -screen 0 1280x720x24 -ac -nolisten tcp >"$xvfb_log" 2>&1 &
xvfb_pid=$!
display_number="${DISPLAY#*:}"
display_number="${display_number%%.*}"
xvfb_socket="/tmp/.X11-unix/X${display_number}"

cleanup() {
  kill "$xvfb_pid" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

for _ in {1..50}; do
  if ! kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    echo "Xvfb failed to start. Log output:" >&2
    cat "$xvfb_log" >&2
    exit 1
  fi

  if [[ -S "$xvfb_socket" ]]; then
    "$@"
    exit $?
  fi

  sleep 0.1
done

echo "Xvfb did not become ready at $DISPLAY. Log output:" >&2
cat "$xvfb_log" >&2
exit 1
