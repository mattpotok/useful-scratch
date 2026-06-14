# Verizon Runner

Downloads the latest Verizon bill PDF and delivers it through Slack or Gmail.

The runner uses Playwright to log into Verizon, open the bill details page, download the bill PDF, and then send the file through the selected delivery method.

## Setup

Install dependencies:

```bash
npm ci
```

Install Playwright's Chromium browser and system dependencies:

```bash
npx playwright install --with-deps chromium
```

Build the TypeScript project:

```bash
npm run build
```

## Configuration

Create a local `.env` file in this directory. This file is loaded by Docker and by native Node runs, and is ignored by git.
Use simple unquoted `KEY=value` lines. Docker's `--env-file` parser does not strip shell-style quotes or expand `${VAR}` references.

```env
VERIZON_USERNAME=your-verizon-user-id
VERIZON_PASSWORD=your-verizon-password
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...
EMAIL_TO=recipient@example.com
```

Slack delivery requires `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`.

Email delivery requires `EMAIL_TO`, plus local Gmail OAuth files:

- `credentials.json`
- `token.json`

Generate or refresh `token.json` from an interactive local terminal before using email delivery in Docker or cron.

Keep `.env`, `credentials.json`, and `token.json` out of git.

## Running

The `--delivery` argument is required and must be either `slack` or `email`.

For native development, build the project and pass an explicit delivery method:

```bash
npm run build
npm run start -- --delivery slack
```

Use email delivery by changing the argument:

```bash
npm run start -- --delivery email
```

## Logs

The runner writes each execution to a timestamped run directory under:

```bash
${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs
```

Set `VERIZON_LOG_ROOT` to override the root log directory.

Each run directory contains:

- `output.log` for terminal output
- `failure.html` for the saved failure page
- `failure.png` for the saved failure screenshot, when screenshot capture succeeds

Runner output is also mirrored to the terminal.

The runner keeps the current run directory plus the two most recent prior run directories.
Docker mounts the host log root into the container and runs with the host UID/GID so diagnostic files remain readable by the current user.

## Verification

Run these before deploying changes:

```bash
npm run format:check
npm run lint
npm run check
npm run build
```

## Docker

The Docker image uses a two-stage build. The build stage installs dev dependencies and compiles TypeScript. The runtime stage installs production dependencies only and runs the compiled output.

The runner intentionally uses headed Chromium. Verizon blocks true headless Chromium before the sign-in form loads, so Docker runs headed Chromium inside Xvfb instead of using `headless: true`.

### Building

Build for the current machine and tag it as `latest`:

```bash
docker build -t verizon-runner:latest .
```

Cross-build for an ARM64 Linux host and export the image for copying without a registry:

```bash
docker buildx build --platform linux/arm64 -t verizon-runner:arm64 --output type=docker,dest=verizon-runner-arm64.tar .
scp verizon-runner-arm64.tar user@remote-host:~
ssh user@remote-host 'docker load -i verizon-runner-arm64.tar'
```

### Running

Use the tag that matches the image you built:

- `verizon-runner:latest` for a local/native image
- `verizon-runner:arm64` for a cross-built ARM64 image

The normal deployment entrypoint is Docker via `run.sh`. It runs Slack delivery and defaults to `verizon-runner:latest`:

```bash
./run.sh
```

Use `DOCKER_IMAGE` to choose a different image tag:

```bash
DOCKER_IMAGE=verizon-runner:<tag> ./run.sh
```

Mount local Gmail OAuth files when using email delivery:

```bash
docker run --rm \
  --ipc=host \
  --env-file .env \
  -e VERIZON_LOG_ROOT=/logs \
  -v "${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs:/logs" \
  -v "$PWD/credentials.json:/app/credentials.json:ro" \
  -v "$PWD/token.json:/app/token.json" \
  verizon-runner:<tag> node --enable-source-maps dist/index.js --delivery email
```

On the remote host, replace `<tag>` with the image tag you loaded and schedule that image instead of rebuilding it:

```cron
<minute> <hour> <day-of-month> * * cd /path/to/verizon && DOCKER_IMAGE=verizon-runner:<tag> ./run.sh
```

Adjust the day and time based on when the bill is reliably available.
