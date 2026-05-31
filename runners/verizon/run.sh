#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-}"

if [[ "$MODE" != "native" && "$MODE" != "docker" ]]; then
  echo "Usage: $0 native|docker" >&2
  exit 2
fi

LOG_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs"
RUN_DIR="$LOG_ROOT/$(date +%F-%H%M%S)"
LOG_FILE="$RUN_DIR/output.log"
DEBUG_DIR="$RUN_DIR/debug"

mkdir -p "$DEBUG_DIR"

find "$LOG_ROOT" -mindepth 1 -maxdepth 1 -type d \
  | sort -r \
  | tail -n +4 \
  | xargs -r rm -rf --

exec > >(tee -a "$LOG_FILE") 2>&1

echo "Runner mode: $MODE"
echo "Run directory: $RUN_DIR"

set -a
source .env
set +a

if [[ "$MODE" == "native" ]]; then
  export VERIZON_DEBUG_DIR="$DEBUG_DIR"

  npm run build
  npm run start -- --delivery slack
else
  docker_image="${DOCKER_IMAGE:-verizon-runner:latest}"
  echo "Docker image: $docker_image"

  docker_env_args=(
    --env VERIZON_USERNAME
    --env VERIZON_PASSWORD
    --env SLACK_BOT_TOKEN
    --env SLACK_CHANNEL_ID
    --env VERIZON_DEBUG_DIR=/tmp/verizon-debug
  )

  if [[ -n "${EMAIL_TO:-}" ]]; then
    docker_env_args+=(--env EMAIL_TO)
  fi

  docker run \
    --rm \
    --ipc=host \
    --user "$(id -u):$(id -g)" \
    --volume "$DEBUG_DIR:/tmp/verizon-debug" \
    "${docker_env_args[@]}" \
    "$docker_image"
fi
