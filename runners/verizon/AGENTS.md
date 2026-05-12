# Verizon Runner Notes

## Project

This is a TypeScript Playwright runner that logs into Verizon, downloads the latest bill PDF, and delivers the PDF by Slack or Gmail.

## Commands

- Install dependencies: `npm ci`
- Typecheck: `npm run check`
- Build: `npm run build`
- Run through script: `./run.sh`
- Run directly: `npm run start -- --delivery slack`

The `--delivery` argument is required and must be either `slack` or `email`.

## Runtime Configuration

Runtime secrets are loaded from `.env` by `run.sh`. Keep `.env` local and untracked.

Expected variables:

- `VERIZON_USERNAME`
- `VERIZON_PASSWORD`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL_ID`
- `EMAIL_TO` when using `--delivery email`

Gmail OAuth files are also local-only:

- `credentials.json`
- `token.json`

These files must not be committed.

## Logging

`run.sh` writes each execution to a timestamped log file under:

`"${XDG_STATE_HOME:-$HOME/.local/state}/runners/verizon/logs"`

Output is also mirrored to the terminal with `tee`.

The script keeps the current log plus the two most recent prior logs.

## Raspberry Pi

The intended deployment target is a Raspberry Pi using Node installed through NodeSource. The script expects `npm` to be available on `PATH`.

Cron should call `run.sh` directly. The script changes into its own directory, loads `.env`, builds, and runs the project.

Example cron shape:

```cron
0 9 16 * * /home/pi/verizon/run.sh
```

## Development Notes

- Keep the Playwright selectors tied to accessible labels or stable IDs from the Verizon pages.
- Keep `downloadLatestBill()` responsible only for producing a local PDF path.
- Keep delivery behavior behind `deliverBill()`.
- On failure, the runner should notify through the selected delivery method and then rethrow so logs and cron show the failed run.

## TypeScript Style

- Keep `strict` TypeScript settings clean. Do not weaken `tsconfig.json` to make an error disappear.
- Use explicit return types on exported functions and async workflow helpers.
- Avoid `any`. If an external API forces unknown data, prefer `unknown` plus a narrow parser or guard.
- Prefer small, named helper functions when a Playwright flow has a distinct page state or side effect.
- Keep environment access centralized through `getRequiredEnvVar()` unless there is a clear reason to do otherwise.

## Code Style

- Follow the existing formatting: 2-space indentation, double quotes, and semicolons.
- Keep imports grouped in this order: Node built-ins, third-party packages, then local imports if any are added later.
- Keep comments brief and useful. Add them for workflow intent or non-obvious browser behavior, not for line-by-line narration.
- Run `npm run format:check`, `npm run lint`, `npm run check`, and `npm run build` after TypeScript changes.
- Use `npm run fix` only for safe ESLint autofixes.
- Use `npm run format` for Prettier formatting.

## Naming And Structure

- Use `camelCase` for variables and functions.
- Use `PascalCase` for types, interfaces, and classes.
- Name workflow helpers after the user-visible action or state they handle, such as `login`, `downloadLatestBill`, or `completeVerificationFlow`.
- Keep secret files, generated browser artifacts, downloaded bills, and OAuth tokens out of git.

## Boundaries

- Do not delete files unless the user explicitly asks for that deletion.
- Keep edits scoped to `runners/verizon` for this runner unless the user asks for repository-wide changes.
- Do not hardcode new secrets in source files. Use `.env` or documented runtime variables.
- Keep `run.sh` cron-friendly: it should set its working directory, load `.env`, log output, build, and run the compiled project.
