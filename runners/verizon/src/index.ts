#!/usr/bin/env -S npx tsx

import "dotenv/config";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import { Command, Option } from "commander";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import open from "open";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GMAIL_CREDENTIALS_PATH = join(PROJECT_ROOT, "credentials.json");
const GMAIL_TOKEN_PATH = join(PROJECT_ROOT, "token.json");

type InstalledCredentials = {
  installed: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

type DeliveryMethod = "slack" | "email";

type Logger = {
  error(message: string): Promise<void>;
  info(message: string): Promise<void>;
  runDirectory: string;
};

interface DeliveryClient {
  sendBill(pdfPath: string): Promise<void>;
  sendError(error: unknown): Promise<void>;
}

let logger: Logger = {
  error: async (message) => {
    process.stderr.write(`${message}\n`);
  },
  info: async (message) => {
    process.stdout.write(`${message}\n`);
  },
  runDirectory: ""
};

function parseCliArgs(): { delivery: DeliveryMethod } {
  const program = new Command();

  program.name("verizon-runner").description("Download the latest Verizon bill and deliver it.");

  program.addOption(
    new Option("--delivery <method>", "delivery method")
      .choices(["slack", "email"])
      .makeOptionMandatory()
  );

  program.parse();

  return program.opts<{ delivery: DeliveryMethod }>();
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function getPasswordOptionButton(page: Page): Locator {
  return page.getByRole("button", { name: /^(Sign in with password|Password)$/ });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
}

function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString("ascii") === "%PDF";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function addErrorContext(error: unknown, context: string): Error {
  const contextualError = new Error(error instanceof Error ? error.message : String(error));

  if (error instanceof Error) {
    contextualError.name = error.name;
    contextualError.stack = `${getErrorMessage(error)}\n\n${context}`;
  } else if (contextualError.stack) {
    contextualError.stack = `${contextualError.stack}\n\n${context}`;
  }

  return contextualError;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function getDefaultLogRoot(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "runners", "verizon", "logs");
}

async function pruneOldRunDirectories(logRoot: string): Promise<void> {
  const entries = await readdir(logRoot, { withFileTypes: true }).catch(() => []);
  const oldRunDirectories = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(3);

  await Promise.all(
    oldRunDirectories.map(async (directoryName) => {
      await rm(join(logRoot, directoryName), { force: true, recursive: true }).catch(
        (error: unknown) => {
          process.stderr.write(
            `Unable to prune old run directory ${directoryName}: ${getErrorMessage(error)}\n`
          );
        }
      );
    })
  );
}

async function createRunDirectory(): Promise<string> {
  const logRoot = process.env.VERIZON_LOG_ROOT ?? getDefaultLogRoot();
  const runDirectory = join(logRoot, formatTimestamp(new Date()));

  await mkdir(runDirectory, { recursive: true });
  await pruneOldRunDirectories(logRoot);

  return runDirectory;
}

async function createLogger(): Promise<Logger> {
  const runDirectory = await createRunDirectory();
  const logPath = join(runDirectory, "output.log");

  async function write(stream: NodeJS.WriteStream, message: string): Promise<void> {
    const line = `${message}\n`;
    stream.write(line);
    await withTimeout(appendFile(logPath, line, "utf8"), 5000, "Timed out writing log file").catch(
      (error: unknown) => {
        stream.write(`Unable to write log file: ${getErrorMessage(error)}\n`);
      }
    );
  }

  return {
    error: (message) => write(process.stderr, message),
    info: (message) => write(process.stdout, message),
    runDirectory
  };
}

async function savePageDiagnostics(
  page: Page,
  label: string,
  diagnosticsDirectory: string
): Promise<string> {
  await mkdir(diagnosticsDirectory, { recursive: true });

  const screenshotPath = join(diagnosticsDirectory, `${label}.png`);
  const htmlPath = join(diagnosticsDirectory, `${label}.html`);
  const title = await page.title().catch(() => "Unable to read page title");
  const diagnosticLines = [
    `Diagnostics saved to: ${diagnosticsDirectory}`,
    `Current URL: ${page.url()}`,
    `Page title: ${title}`
  ];

  await page
    .screenshot({ path: screenshotPath, fullPage: true, timeout: 10000 })
    .then(() => {
      diagnosticLines.push(`Screenshot: ${screenshotPath}`);
    })
    .catch((error: unknown) => {
      diagnosticLines.push(`Screenshot failed: ${getErrorMessage(error)}`);
    });

  await page
    .content()
    .then((content) => writeFile(htmlPath, content, "utf8"))
    .then(() => {
      diagnosticLines.push(`HTML: ${htmlPath}`);
    })
    .catch((error: unknown) => {
      diagnosticLines.push(`HTML capture failed: ${getErrorMessage(error)}`);
    });

  return diagnosticLines.join("\n");
}

async function openSignInPage(page: Page): Promise<Locator> {
  await page.goto("https://secure.verizon.com/signin", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const usernameField = page.locator("#username");
  await usernameField.waitFor({ state: "visible", timeout: 45000 });
  return usernameField;
}

async function submitPassword(page: Page, password: string): Promise<void> {
  await logger.info("Waiting for password field.");
  await page.locator("#password").waitFor({ state: "visible" });
  await page.locator("#password").fill(password);
  await logger.info("Submitting password.");
  await page.locator("#mvo-main-button").click();
}

async function completePasswordOnlyFlow(page: Page, password: string): Promise<void> {
  const passwordOptionButton = getPasswordOptionButton(page);

  // Some sessions show a method picker before the password form.
  await logger.info("Password-only flow detected; selecting password option.");
  await passwordOptionButton.waitFor({ state: "visible" });
  await passwordOptionButton.click();
  await submitPassword(page, password);

  await logger.info("Waiting for dashboard after password-only login.");
  await page.getByRole("heading", { name: /^Hi,/ }).waitFor({
    state: "visible",
    timeout: 180000
  });
}

async function completeVerificationFlow(page: Page, password: string): Promise<void> {
  const rememberVerificationRadio = page.locator("#remember-verification-radio");
  const countdownHeading = page.getByText("We sent you an authorization request.");
  const expiredBanner = page.getByText("The authentication request has expired.");

  // This path submits a password first, then waits for phone authorization.
  await submitPassword(page, password);
  await logger.info("Selecting remember-verification option.");
  await rememberVerificationRadio.waitFor({ state: "visible" });
  await rememberVerificationRadio.check();
  await page.getByRole("button", { name: "Continue" }).click();

  await logger.info("Waiting for phone authorization request.");
  await countdownHeading.waitFor({ state: "visible" });

  await logger.info("Waiting for dashboard or expired verification.");
  const loginResult = await Promise.race([
    page
      .getByRole("heading", { name: /^Hi,/ })
      .waitFor({ state: "visible", timeout: 180000 })
      .then(() => "dashboard" as const),
    expiredBanner.waitFor({ state: "visible", timeout: 180000 }).then(() => "expired" as const)
  ]);

  if (loginResult === "expired") {
    throw new Error("Verizon verification request expired before login completed.");
  }
}

async function downloadLatestBill(page: Page): Promise<string> {
  await logger.info("Opening Verizon bill details page.");
  await page.goto("https://www.verizon.com/digital/nsa/secure/ui/ngd/bill/billdetails", {
    waitUntil: "domcontentloaded"
  });

  const reviewBillPdfButton = page.getByRole("link", { name: "Review Bill PDF" });
  const downloadDirectory = await mkdtemp(join(tmpdir(), "verizon-bill-"));
  const pdfPath = join(downloadDirectory, "latest-bill.pdf");

  await logger.info("Waiting for Review Bill PDF link.");
  await reviewBillPdfButton.waitFor({ state: "visible" });
  await logger.info("Opening Review Bill PDF.");
  const popupPromise = page.context().waitForEvent("page", { timeout: 10000 });
  await reviewBillPdfButton.click();

  // Verizon opens the PDF in a popup; fetch that URL with the same authenticated context.
  const popupPage = await popupPromise;

  try {
    await popupPage.waitForURL(
      (url) => url.hostname.endsWith("verizon.com") && url.pathname.endsWith("/bill_pdfdoc"),
      { timeout: 15000 }
    );

    const pdfUrl = popupPage.url();
    const response = await page.context().request.get(pdfUrl);
    if (!response.ok()) {
      throw new Error(`Unable to download bill PDF from ${pdfUrl}.`);
    }

    const pdfBuffer = Buffer.from(await response.body());
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/pdf") && !isPdfBuffer(pdfBuffer)) {
      throw new Error(
        `Expected Verizon bill PDF from ${pdfUrl}, received ${contentType || "unknown content type"}.`
      );
    }

    await writeFile(pdfPath, pdfBuffer);
  } finally {
    await popupPage.close().catch(() => undefined);
  }

  await logger.info(`Latest bill saved to: ${downloadDirectory}`);
  return pdfPath;
}

async function getGmailAuthClient() {
  const credentials = JSON.parse(
    await readFile(GMAIL_CREDENTIALS_PATH, "utf8")
  ) as InstalledCredentials;
  const installedCredentials = credentials.installed;

  if (!installedCredentials) {
    throw new Error("credentials.json must contain Desktop app OAuth credentials.");
  }

  const authClient = new OAuth2Client(
    installedCredentials.client_id,
    installedCredentials.client_secret,
    installedCredentials.redirect_uris[0]
  );

  const existingToken = await readFile(GMAIL_TOKEN_PATH, "utf8")
    .then((token) => JSON.parse(token))
    .catch(() => null);

  if (existingToken) {
    authClient.setCredentials(existingToken);
    return authClient;
  }

  // First Gmail run requires interactive OAuth; future runs reuse token.json.
  const authUrl = authClient.generateAuthUrl({
    access_type: "offline",
    scope: GMAIL_SCOPES
  });
  await logger.info(`Authorize Gmail access: ${authUrl}`);

  if (!input.isTTY) {
    throw new Error(
      "Gmail OAuth token.json is missing or expired, but this process has no interactive TTY. Regenerate token.json from a local terminal before using email delivery in Docker or cron."
    );
  }

  await open(authUrl);

  const readline = createInterface({ input, output });
  const code = await readline.question("Paste the Gmail authorization code: ");
  readline.close();

  const { tokens } = await authClient.getToken(code);
  authClient.setCredentials(tokens);
  await writeFile(GMAIL_TOKEN_PATH, JSON.stringify(tokens, null, 2));

  return authClient;
}

class EmailDeliveryClient implements DeliveryClient {
  readonly #recipient = getRequiredEnvVar("EMAIL_TO");

  async sendBill(pdfPath: string): Promise<void> {
    const auth = await getGmailAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const pdfBuffer = await readFile(pdfPath);
    const boundary = `verizon-bill-${Date.now()}`;
    const message = [
      `To: ${this.#recipient}`,
      "Subject: Latest Verizon bill",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Attached is the latest Verizon bill PDF.",
      "",
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="latest-bill.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdfBuffer.toString("base64"),
      "",
      `--${boundary}--`
    ].join("\r\n");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64UrlEncode(message)
      }
    });

    await logger.info(`Latest bill emailed to: ${this.#recipient}`);
  }

  async sendError(error: unknown): Promise<void> {
    const auth = await getGmailAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const message = [
      `To: ${this.#recipient}`,
      "Subject: Verizon bill runner failed",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      getErrorMessage(error)
    ].join("\r\n");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: base64UrlEncode(message)
      }
    });

    await logger.info(`Failure notification emailed to: ${this.#recipient}`);
  }
}

class SlackDeliveryClient implements DeliveryClient {
  readonly #channelId = getRequiredEnvVar("SLACK_CHANNEL_ID");
  readonly #slack = new WebClient(getRequiredEnvVar("SLACK_BOT_TOKEN"));

  async sendBill(pdfPath: string): Promise<void> {
    const pdfBuffer = await readFile(pdfPath);

    await this.#slack.files.uploadV2({
      channel_id: this.#channelId,
      file: pdfBuffer,
      filename: "latest-verizon-bill.pdf",
      title: "Latest Verizon bill",
      initial_comment: "Latest Verizon bill PDF"
    });

    await logger.info(`Latest bill uploaded to Slack channel: ${this.#channelId}`);
  }

  async sendError(error: unknown): Promise<void> {
    await this.#slack.chat.postMessage({
      channel: this.#channelId,
      text: `Verizon bill runner failed:\n\`\`\`${getErrorMessage(error)}\`\`\``
    });

    await logger.info(`Failure notification sent to Slack channel: ${this.#channelId}`);
  }
}

function createDeliveryClient(delivery: DeliveryMethod): DeliveryClient {
  if (delivery === "slack") {
    return new SlackDeliveryClient();
  }

  return new EmailDeliveryClient();
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await logger.info("Opening Verizon sign-in page.");
  const usernameField = await openSignInPage(page);

  await logger.info("Submitting username.");
  await usernameField.fill(username);
  await page.locator("#mvo-main-button").click();

  // After username submission Verizon chooses one of two login experiences.
  const passwordOptionButton = getPasswordOptionButton(page);
  const passwordField = page.locator("#password");
  const nextStep = await Promise.race([
    passwordOptionButton
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => "password-only" as const),
    passwordField.waitFor({ state: "visible", timeout: 10000 }).then(() => "verification" as const)
  ]).catch(() => null);

  await logger.info(`Detected Verizon login flow: ${nextStep ?? "unknown"}.`);

  if (nextStep === "password-only") {
    await completePasswordOnlyFlow(page, password);
  } else if (nextStep === "verification") {
    await completeVerificationFlow(page, password);
  } else {
    throw new Error("Unable to determine Verizon login flow after username submission.");
  }
}

async function main(): Promise<void> {
  const { delivery } = parseCliArgs();
  let deliveryClient: DeliveryClient | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    deliveryClient = createDeliveryClient(delivery);
    logger = await createLogger();
    await logger.info(`Run directory: ${logger.runDirectory}`);

    const username = getRequiredEnvVar("VERIZON_USERNAME");
    const password = getRequiredEnvVar("VERIZON_PASSWORD");

    await logger.info("Launching Chromium with headless=false");
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    page = await context.newPage();

    await login(page, username, password);
    const pdfPath = await downloadLatestBill(page);
    await deliveryClient.sendBill(pdfPath);
  } catch (error) {
    // Notify through the selected delivery method, then exit nonzero for cron visibility.
    const diagnostics = page
      ? await savePageDiagnostics(page, "failure", logger.runDirectory).catch(
          (diagnosticError) =>
            `Unable to save page diagnostics: ${getErrorMessage(diagnosticError)}`
        )
      : `Diagnostics unavailable because the browser page was not created.\nRun directory: ${logger.runDirectory}`;

    const failure = addErrorContext(error, diagnostics);
    await deliveryClient
      ?.sendError(failure)
      .catch((deliveryError: unknown) =>
        logger.error(`Unable to deliver failure notification: ${getErrorMessage(deliveryError)}`)
      );
    await logger.error(getErrorMessage(failure));
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

await main().catch((error: unknown) => {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
});
