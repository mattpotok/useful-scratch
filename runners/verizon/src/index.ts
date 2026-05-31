#!/usr/bin/env -S npx tsx

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import { Command, Option } from "commander";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import open from "open";
import { chromium, type Locator, type Page } from "playwright";

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
  const value = process.env[name];

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

async function savePageDiagnostics(page: Page, label: string): Promise<string> {
  const diagnosticsBaseDirectory = process.env.VERIZON_DEBUG_DIR ?? tmpdir();
  const diagnosticsDirectory = await mkdtemp(join(diagnosticsBaseDirectory, "verizon-debug-"));
  const screenshotPath = join(diagnosticsDirectory, `${label}.png`);
  const htmlPath = join(diagnosticsDirectory, `${label}.html`);
  const title = await page.title().catch(() => "Unable to read page title");

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeFile(htmlPath, await page.content(), "utf8").catch(() => undefined);

  return [
    `Diagnostics saved to: ${diagnosticsDirectory}`,
    `Current URL: ${page.url()}`,
    `Page title: ${title}`,
    `Screenshot: ${screenshotPath}`,
    `HTML: ${htmlPath}`
  ].join("\n");
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
  await page.locator("#password").waitFor({ state: "visible" });
  await page.locator("#password").fill(password);
  await page.locator("#mvo-main-button").click();
}

async function completePasswordOnlyFlow(page: Page, password: string): Promise<void> {
  const passwordOptionButton = getPasswordOptionButton(page);

  // Some sessions show a method picker before the password form.
  await passwordOptionButton.waitFor({ state: "visible" });
  await passwordOptionButton.click();
  await submitPassword(page, password);

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
  await rememberVerificationRadio.waitFor({ state: "visible" });
  await rememberVerificationRadio.check();
  await page.getByRole("button", { name: "Continue" }).click();

  await countdownHeading.waitFor({ state: "visible" });

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
  await page.goto("https://www.verizon.com/digital/nsa/secure/ui/ngd/bill/billdetails", {
    waitUntil: "domcontentloaded"
  });

  const reviewBillPdfButton = page.getByRole("link", { name: "Review Bill PDF" });
  const downloadDirectory = await mkdtemp(join(tmpdir(), "verizon-bill-"));
  const pdfPath = join(downloadDirectory, "latest-bill.pdf");

  await reviewBillPdfButton.waitFor({ state: "visible" });
  await reviewBillPdfButton.click();

  // Verizon opens the PDF in a popup; fetch that URL with the same authenticated context.
  const popupPromise = page.context().waitForEvent("page", { timeout: 10000 });
  const popupPage = await popupPromise;
  await popupPage.waitForLoadState("domcontentloaded");

  const response = await page.context().request.get(popupPage.url());
  if (!response.ok()) {
    throw new Error(`Unable to download bill PDF from ${popupPage.url()}.`);
  }

  const pdfBuffer = Buffer.from(await response.body());
  await writeFile(pdfPath, pdfBuffer);
  await popupPage.close();
  console.log(`Latest bill saved to: ${downloadDirectory}`);
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
  console.log(`Authorize Gmail access: ${authUrl}`);
  await open(authUrl);

  const readline = createInterface({ input, output });
  const code = await readline.question("Paste the Gmail authorization code: ");
  readline.close();

  const { tokens } = await authClient.getToken(code);
  authClient.setCredentials(tokens);
  await writeFile(GMAIL_TOKEN_PATH, JSON.stringify(tokens, null, 2));

  return authClient;
}

async function sendBillEmail(pdfPath: string, recipient: string): Promise<void> {
  const auth = await getGmailAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const pdfBuffer = await readFile(pdfPath);
  const boundary = `verizon-bill-${Date.now()}`;
  const message = [
    `To: ${recipient}`,
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

  console.log(`Latest bill emailed to: ${recipient}`);
}

async function sendErrorEmail(error: unknown, recipient: string): Promise<void> {
  const auth = await getGmailAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const message = [
    `To: ${recipient}`,
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

  console.log(`Failure notification emailed to: ${recipient}`);
}

async function uploadBillToSlack(pdfPath: string): Promise<void> {
  const slackToken = getRequiredEnvVar("SLACK_BOT_TOKEN");
  const slackChannelId = getRequiredEnvVar("SLACK_CHANNEL_ID");
  const slack = new WebClient(slackToken);
  const pdfBuffer = await readFile(pdfPath);

  await slack.files.uploadV2({
    channel_id: slackChannelId,
    file: pdfBuffer,
    filename: "latest-verizon-bill.pdf",
    title: "Latest Verizon bill",
    initial_comment: "Latest Verizon bill PDF"
  });

  console.log(`Latest bill uploaded to Slack channel: ${slackChannelId}`);
}

async function sendErrorToSlack(error: unknown): Promise<void> {
  const slackToken = getRequiredEnvVar("SLACK_BOT_TOKEN");
  const slackChannelId = getRequiredEnvVar("SLACK_CHANNEL_ID");
  const slack = new WebClient(slackToken);

  await slack.chat.postMessage({
    channel: slackChannelId,
    text: `Verizon bill runner failed:\n\`\`\`${getErrorMessage(error)}\`\`\``
  });

  console.log(`Failure notification sent to Slack channel: ${slackChannelId}`);
}

async function deliverBill(pdfPath: string, delivery: DeliveryMethod): Promise<void> {
  if (delivery === "slack") {
    await uploadBillToSlack(pdfPath);
  } else {
    await sendBillEmail(pdfPath, getRequiredEnvVar("EMAIL_TO"));
  }
}

async function deliverError(error: unknown, delivery: DeliveryMethod): Promise<void> {
  if (delivery === "slack") {
    await sendErrorToSlack(error);
  } else {
    await sendErrorEmail(error, getRequiredEnvVar("EMAIL_TO"));
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  const usernameField = await openSignInPage(page);

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

  const username = getRequiredEnvVar("VERIZON_USERNAME");
  const password = getRequiredEnvVar("VERIZON_PASSWORD");
  console.log("Launching Chromium with headless=false");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  let failure: unknown;

  try {
    await login(page, username, password);
    const pdfPath = await downloadLatestBill(page);
    await deliverBill(pdfPath, delivery);
  } catch (error) {
    // Notify through the selected delivery method, then rethrow for cron/log visibility.
    const diagnostics = await savePageDiagnostics(page, "failure").catch(
      (diagnosticError) => `Unable to save page diagnostics: ${getErrorMessage(diagnosticError)}`
    );

    failure = addErrorContext(error, diagnostics);
    await deliverError(failure, delivery);
  } finally {
    await page.waitForTimeout(3000);
    await context.close();
    await browser.close();
  }

  if (failure) {
    throw failure;
  }
}

await main();
