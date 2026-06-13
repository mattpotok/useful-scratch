#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs"
mkdir -p "$LOG_ROOT"

docker_image="${DOCKER_IMAGE:-verizon-runner:latest}"
echo "Docker image: $docker_image"

docker run \
  --rm \
  --ipc=host \
  --env-file .env \
  --env VERIZON_LOG_ROOT=/logs \
  --env HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  --volume "$LOG_ROOT:/logs" \
  "$docker_image"
