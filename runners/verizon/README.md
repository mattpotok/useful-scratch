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

Create a local `.env` file in this directory. This file is loaded by `run.sh` and is ignored by git.

```bash
VERIZON_USERNAME='your-verizon-user-id'
VERIZON_PASSWORD='your-verizon-password'
SLACK_BOT_TOKEN='xoxb-...'
SLACK_CHANNEL_ID='C...'
EMAIL_TO='recipient@example.com'
```

Slack delivery requires `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`.

Email delivery requires `EMAIL_TO`, plus local Gmail OAuth files:

- `credentials.json`
- `token.json`

Keep `.env`, `credentials.json`, and `token.json` out of git.

## Running

The normal entrypoint is:

```bash
./run.sh
```

`run.sh` loads `.env`, builds the project, and runs Slack delivery:

```bash
npm run start -- --delivery slack
```

To run manually with Slack:

```bash
npm run build
npm run start -- --delivery slack
```

To run manually with email:

```bash
npm run build
npm run start -- --delivery email
```

The `--delivery` argument is required and must be either `slack` or `email`.

## Logs

`run.sh` writes each execution to a timestamped log file under:

```bash
${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs
```

Output is also mirrored to the terminal.

The script keeps the current log plus the two most recent prior logs.

## Raspberry Pi

The intended Raspberry Pi setup uses Node installed through NodeSource.

Install Node 24:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then set up the runner:

```bash
cd /home/pi/verizon
npm ci
npx playwright install --with-deps chromium
npm run build
```

Schedule it with cron:

```cron
0 9 16 * * /home/pi/verizon/run.sh
```

Adjust the day and time based on when the bill is reliably available.

## Verification

Run these before deploying changes:

```bash
npm run format:check
npm run lint
npm run check
npm run build
```
