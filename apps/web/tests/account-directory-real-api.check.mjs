import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";
import { createLoopbackBridge } from "./browser-network.mjs";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { checkAdminAssets, captureAdminPreview } from "./admin-asset-details.mjs";

assert.ok(process.env.SPATIA_API_ORIGIN && process.env.SPATIA_TEST_ADMIN);
const started = performance.now();
const stage = (name) => console.log(`${Math.round(performance.now() - started)}ms: ${name}`);
stage("starting browser fixture");
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const upstream = `https://127.0.0.1:${server.httpServer.address().port}`;
const bridge = createLoopbackBridge(upstream, {
  ca: readFileSync(process.env.SPATIA_DEV_TLS_CERT),
});
await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.address().port}`;
const browser = await launchBrowser({ target: origin });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin + "/login");
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_ADMIN);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  if (process.env.SPATIA_TEST_FORCED_ADMIN === "true") {
    await page.getByRole("heading", { name: "Change your password." }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/login");
    await page.getByLabel("Current password", { exact: true }).fill("Synthetic-long-password1!");
    await page.getByLabel("New password", { exact: true }).fill("Admin-replacement2!");
    await page.getByLabel("Confirm new password", { exact: true }).fill("Admin-replacement2!");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
  }
  await page.waitForURL(origin + "/admin/dashboard");
  stage("administrator signed in");
  await page.getByRole("heading", { name: /Welcome Back,/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /View Details for Dashboard browser project/i }).count(),
    0,
    "Unpublished drafts must not appear in the admin published-project list",
  );
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  await page.getByLabel("Organisation name", { exact: true }).fill("Museum Studies Studio");
  await page.getByRole("button", { name: "Create Organisation", exact: true }).click();
  await page.waitForURL(/\/organisations\?organisation=[a-f0-9-]{36}$/);
  await page.getByRole("heading", { name: "Museum Studies Studio", exact: true }).waitFor();
  await page.getByText("No accounts yet.", { exact: false }).waitFor();
  if (process.env.SPATIA_TEST_FORCED_ADMIN !== "true") {
    await captureAdminPreview(page, "organisation-created");
    const library = await context.newPage();
    try {
      await checkAdminAssets(library, origin);
    } finally {
      await library.close();
    }
  }
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "+ Add Accounts" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Browser Created");
  await dialog.getByLabel("Username", { exact: true }).fill("browser.created");
  await dialog.getByLabel("Password", { exact: true }).fill("Browser-initial1!");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("button", { name: "Close organisation", exact: true }).waitFor();
  await page.getByRole("button", { name: "View account for Browser Created" }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("Password", { exact: true }).inputValue(), "");
  for (const field of ["name", "username", "account type", "password"])
    await dialog.getByRole("button", { name: `Override ${field}`, exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Browser Updated");
  await dialog.getByLabel("Username", { exact: true }).fill("browser.updated");
  await dialog.getByRole("combobox", { name: "Account Type", exact: true }).click();
  await page.getByRole("option", { name: "Facilitator", exact: true }).click();
  await dialog.getByLabel("New Password", { exact: true }).fill("Browser-replacement2!");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("button", { name: "Close organisation", exact: true }).waitFor();
  await page.getByRole("button", { name: "View account for Browser Updated" }).waitFor();
  // Exercise recovery against the real API after a failed directory load.
  let failOrganizations = true;
  await page.route(/\/api\/v1\/admin\/organizations(?:\?|$)/, (route) =>
    failOrganizations
      ? route.fulfill({ status: 503, json: { code: "directory_unavailable" } })
      : route.continue(),
  );
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "directory request failed" }).waitFor();
  failOrganizations = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Close organisation", exact: true }).waitFor();
  await page.getByRole("button", { name: "View account for Browser Updated" }).waitFor();
  assert.equal(await page.getByText("Dashboard browser project", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "View account for Browser Updated" }).waitFor();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: /Loading/ })
      .count(),
    0,
  );
  let imported = 0;
  stage("directory CRUD and failed-load recovery complete");
  let operationId = "";
  let importOrganizationId = "";
  const bulkPath = /\/api\/v1\/admin\/organizations\/[\da-f-]+\/bulk-imports\/[\da-f-]+$/;
  await page.route(bulkPath, async (route) => {
    const upstream = await route.fetch();
    if (upstream.status() !== 201) {
      const problem = await upstream.json().catch(() => null);
      assert.fail(
        `Provisioning must commit before the reply is lost (HTTP ${upstream.status()}, ${problem?.code ?? "unknown problem"}).`,
      );
    }
    imported++;
    operationId = new URL(route.request().url()).pathname.split("/").at(-1);
    importOrganizationId = new URL(route.request().url()).pathname.split("/").at(-3);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "+ Add Accounts", exact: true }).click();
  let importer = page.getByRole("dialog", { name: "Account Creation", exact: true });
  const picker = page.waitForEvent("filechooser");
  await importer.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: "recovery.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,DOB\nReceipt Student,2008-01-02"),
  });
  await importer.getByRole("button", { name: "Save changes", exact: true }).click();
  await importer.getByRole("alert").waitFor();
  assert.equal(imported, 1);
  await page.reload();
  await page.getByRole("button", { name: "Resume account import", exact: true }).click();
  importer = page.getByRole("dialog", { name: "Account Creation", exact: true });
  await importer.getByRole("button", { name: "Check import receipt", exact: true }).click();
  await importer.getByText("Receipt Student", { exact: true }).waitFor();
  stage("lost import response recovered");
  let legacyOperationId = "";
  await page.route(/\/api\/v1\/admin\/users\/bulk$/, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    assert.equal((await response.json()).length, 1);
    legacyOperationId = response.headers()["x-spatia-operation-id"];
    assert.ok(legacyOperationId);
    await route.abort("failed");
  });
  const legacyReply = await page.evaluate(async (orgId) => {
    const csrf = await (await fetch("/api/v1/auth/csrf")).json();
    try {
      await fetch("/api/v1/admin/users/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
        body: JSON.stringify([
          {
            userName: "legacy.receipt.student",
            displayName: "Legacy Receipt Student",
            initialPassword: "Legacy-receipt-password1!",
            role: "Creator",
            orgId,
          },
        ]),
      });
      return "received";
    } catch {
      return "lost";
    }
  }, importOrganizationId);
  assert.equal(legacyReply, "lost");
  stage("legacy import committed with lost response");
  const freshProfile = await browser.newContext();
  const handoffPage = await freshProfile.newPage();
  handoffPage.on("request", (request) => {
    if (request.method() === "PUT" && bulkPath.test(new URL(request.url()).pathname)) imported++;
  });
  await handoffPage.goto(origin + "/login");
  await handoffPage.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_ADMIN);
  await handoffPage
    .getByLabel("Password", { exact: true })
    .fill(
      process.env.SPATIA_TEST_FORCED_ADMIN === "true"
        ? "Admin-replacement2!"
        : "Synthetic-long-password1!",
    );
  await handoffPage.getByRole("button", { name: "Log in", exact: true }).click();
  await handoffPage.waitForURL(origin + "/admin/dashboard");
  await handoffPage.goto(page.url());
  assert.equal(
    await handoffPage.evaluate(
      () => Object.keys(localStorage).filter((key) => key.startsWith("spatia.bulk-import:")).length,
    ),
    0,
  );
  await handoffPage
    .getByRole("region", { name: "Unacknowledged account imports" })
    .getByRole("button", { name: `Review import ${operationId}`, exact: true })
    .click();
  importer = handoffPage.getByRole("dialog", { name: "Account Creation", exact: true });
  await importer.getByRole("button", { name: "Check import receipt", exact: true }).click();
  await importer.getByText("Receipt Student", { exact: true }).waitFor();
  const fileEvent = handoffPage.waitForEvent("download");
  await importer.getByRole("button", { name: "Download credentials", exact: true }).click();
  const handoff = await fileEvent;
  const lines = (await readFile(await handoff.path(), "utf8")).trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  const cells = lines[1].slice(1, -1).split('","');
  assert.equal(cells[0], "Receipt Student");
  assert.equal(cells[1], "receiptstudent02012008");
  assert.ok(cells[2].length >= 12);
  const containsCredential = await handoffPage.evaluate(
    (password) =>
      [localStorage, sessionStorage].some((store) =>
        Object.values(store).some((value) => value.includes(password)),
      ),
    cells[2],
  );
  assert.equal(containsCredential, false);
  await importer
    .getByRole("button", { name: "Acknowledge credential handoff", exact: true })
    .click();
  await importer.waitFor({ state: "detached" });
  assert.equal(imported, 1);
  await handoffPage
    .getByRole("region", { name: "Unacknowledged account imports" })
    .getByRole("button", { name: `Review import ${legacyOperationId}`, exact: true })
    .click();
  importer = handoffPage.getByRole("dialog", { name: "Account Creation", exact: true });
  await importer.getByRole("button", { name: "Check import receipt", exact: true }).click();
  await importer.getByText("Legacy Receipt Student", { exact: true }).waitFor();
  const legacyDownload = handoffPage.waitForEvent("download");
  await importer.getByRole("button", { name: "Download credentials", exact: true }).click();
  const legacyCsv = await readFile(await (await legacyDownload).path(), "utf8");
  assert.ok(
    legacyCsv.includes(
      '"Legacy Receipt Student","legacy.receipt.student","Legacy-receipt-password1!"',
    ),
  );
  assert.equal(
    await handoffPage.evaluate(() =>
      [localStorage, sessionStorage].some((storage) =>
        Object.values(storage).some((value) => value.includes("Legacy-receipt-password1!")),
      ),
    ),
    false,
  );
  await importer
    .getByRole("button", { name: "Acknowledge credential handoff", exact: true })
    .click();
  await importer.waitFor({ state: "detached" });
  assert.equal(imported, 1);
  await freshProfile.close();
  stage("fresh-profile credential handoffs complete");
  const learnerContext = await browser.newContext();
  const learnerPage = await learnerContext.newPage();
  await learnerPage.goto(origin + "/login");
  await learnerPage.getByLabel("Username", { exact: true }).fill(cells[1]);
  await learnerPage.getByLabel("Password", { exact: true }).fill(cells[2]);
  await learnerPage.getByRole("button", { name: "Log in", exact: true }).click();
  await learnerPage.getByRole("heading", { name: "Change your password." }).waitFor();
  await learnerContext.close();
  const owner = await browser.newContext();
  const login = await owner.newPage();
  await login.goto(origin + "/login");
  await login.getByLabel("Username", { exact: true }).fill("browser.updated");
  await login.getByLabel("Password", { exact: true }).fill("Browser-replacement2!");
  await login.getByRole("button", { name: "Log in", exact: true }).click();
  await login.getByRole("heading", { name: "Change your password." }).waitFor();
  const session = await login.evaluate(async () => (await fetch("/api/v1/auth/session")).json());
  assert.equal(session.displayName, "Browser Updated");
  assert.equal(session.role, "Educator");
  assert.equal(session.mustChangePassword, true);
  await owner.close();
  console.log(
    "Real API browser test passed: admin login, dashboard, organisation creation, accounts, overrides and failed-load recovery.",
  );
} finally {
  stage("closing browser");
  await browser.close();
  stage("closing HTTP bridge");
  await new Promise((resolve) => bridge.close(resolve));
  stage("closing Vite");
  await server.close();
  stage("fixture closed");
}
