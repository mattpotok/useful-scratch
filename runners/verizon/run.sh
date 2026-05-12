#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%F-%H%M%S).log"

find "$LOG_DIR" -maxdepth 1 -type f -name "*.log" \
  | sort -r \
  | tail -n +4 \
  | xargs -r rm --

exec > >(tee -a "$LOG_FILE") 2>&1

set -a
source .env
set +a

npm run build
npm run start -- --delivery slack
