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
  await page.getByRole("button", { name: "Create", exact: true }).click();
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
  await page.getByRole("button", { name: "+ Add Organisation", exact: true }).click();
  await page.getByLabel("Organisation name", { exact: true }).fill("Directory Studio");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/admin/organizations" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const receipt = await (await created).json();
  await page.waitForURL(origin + "/organisations?organisation=" + receipt.id);
  await page.getByRole("heading", { name: "Directory Studio", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  await page.getByRole("dialog", { name: "Account Creation" }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "Add Accounts" }).click();
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
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const normal = page.getByRole("dialog", { name: "Account Creation" });
  await normal.locator('input[type="file"]').setInputFiles({
    name: "new-accounts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,DOB\nNew Learner,2009-03-04"),
  });
  const automatic = page.waitForEvent("download");
  await normal.getByRole("button", { name: "Save changes" }).click();
  const normalFile = await automatic;
  const normalRows = (await readFile(await normalFile.path(), "utf8")).trimEnd().split("\r\n");
  assert.equal(normalRows.length, 2);
  const [normalName, normalUser, normalPassword] = normalRows[1].slice(1, -1).split('","');
  assert.equal(normalName, "New Learner");
  assert.equal(normalUser, "newlearner04032009");
  await normal.waitFor({ state: "detached" });
  const learner = await browser.newContext();
  try {
    const signIn = await learner.newPage();
    await signIn.goto(origin + "/login");
    await signIn.getByLabel("Username", { exact: true }).fill(normalUser);
    await signIn.getByLabel("Password", { exact: true }).fill(normalPassword);
    await signIn.getByRole("button", { name: "Log in", exact: true }).click();
    await signIn.getByRole("heading", { name: "Change your password." }).waitFor();
  } finally {
    await learner.close();
  }
  stage("automatic download, form closure and downloaded login verified");
  const receiptPath = /\/bulk-imports\/[\da-f-]+\/receipt$/;
  await page.route(receiptPath, (route) => route.abort("failed"));
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
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
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
  const retry = importer.getByRole("button", { name: "Check again", exact: true });
  await retry.waitFor();
  await page.unroute(receiptPath);
  const checkedReceipt = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/" + operationId + "/receipt") &&
      response.request().method() === "POST",
  );
  await retry.click();
  assert.equal((await checkedReceipt).status(), 200);
  await importer.getByRole("button", { name: "Download login details", exact: true }).waitFor();
  assert.equal(imported, 1);
  await page.reload();
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  importer = page.getByRole("dialog", { name: "Account Creation", exact: true });
  await importer.getByRole("button", { name: "Download login details", exact: true }).waitFor();
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
  const availableImports = await handoffPage.evaluate(async (orgId) => {
    const response = await fetch("/api/v1/admin/organizations/" + orgId + "/bulk-imports?limit=20");
    if (!response.ok) throw new Error("Could not load import receipts");
    return (await response.json()).items.map((item) => item.operationId);
  }, importOrganizationId);
  assert.ok(availableImports.includes(operationId));
  assert.ok(availableImports.includes(legacyOperationId));
  await importer.getByRole("button", { name: "Download login details", exact: true }).waitFor();
  const fileEvent = page.waitForEvent("download");
  await importer.getByRole("button", { name: "Download login details", exact: true }).click();
  const handoff = await fileEvent;
  const lines = (await readFile(await handoff.path(), "utf8")).trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  const cells = lines[1].slice(1, -1).split('","');
  assert.equal(cells[0], "Receipt Student");
  assert.equal(cells[1], "receiptstudent02012008");
  assert.ok(cells[2].length >= 12);
  const containsCredential = await page.evaluate(
    (password) =>
      [localStorage, sessionStorage].some((store) =>
        Object.values(store).some((value) => value.includes(password)),
      ),
    cells[2],
  );
  assert.equal(containsCredential, false);
  await importer.getByRole("button", { name: "Done", exact: true }).click();
  await importer.waitFor({ state: "detached" });
  assert.equal(imported, 1);
  await handoffPage.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const freshForm = handoffPage.getByRole("dialog", { name: "Account Creation" });
  const fileButton = freshForm.getByRole("button", { name: "Download login details", exact: true });
  await fileButton.waitFor();
  assert.equal(
    await freshForm.getByRole("combobox").count(),
    1,
    "Only Account Type needs a dropdown",
  );
  const uploadButton = freshForm.getByRole("button", { name: "Upload CSV", exact: true });
  const [left, right] = await Promise.all([fileButton.boundingBox(), uploadButton.boundingBox()]);
  assert.ok(Math.abs(left.y + left.height / 2 - right.y - right.height / 2) <= 1);
  await captureAdminPreview(handoffPage, "fresh-browser-download-only", freshForm);
  const recoveredFile = handoffPage.waitForEvent("download");
  await fileButton.click();
  const recoveredCsv = await readFile(await (await recoveredFile).path(), "utf8");
  assert.equal(recoveredCsv.trimEnd().split("\r\n").length, 3);
  assert.ok(recoveredCsv.includes('"legacy.receipt.student"'));
  assert.ok(recoveredCsv.includes('"Legacy-receipt-password1!"'));
  assert.ok(recoveredCsv.includes('"' + normalPassword + '"'));
  // A download starting does not establish receipt. Exercise the existing explicit acknowledgement separately.
  const ack = await handoffPage.evaluate(
    async ({ org, id }) => {
      const csrf = await (await fetch("/api/v1/auth/csrf")).json();
      return (
        await fetch("/api/v1/admin/organizations/" + org + "/bulk-imports/" + id + "/acknowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
          body: "{}",
        })
      ).status;
    },
    { org: importOrganizationId, id: legacyOperationId },
  );
  assert.equal(ack, 204);
  const studentContext = await browser.newContext();
  try {
    const student = await studentContext.newPage();
    await student.goto(origin + "/login");
    await student.getByLabel("Username", { exact: true }).fill(normalUser);
    await student.getByLabel("Password", { exact: true }).fill(normalPassword);
    await student.getByRole("button", { name: "Log in", exact: true }).click();
    await student.getByLabel("Current password", { exact: true }).fill(normalPassword);
    await student.getByLabel("New password", { exact: true }).fill("New-learner-password2!");
    await student
      .getByLabel("Confirm new password", { exact: true })
      .fill("New-learner-password2!");
    await student.getByRole("button", { name: "Change password", exact: true }).click();
    await student.getByLabel("Current password", { exact: true }).waitFor({ state: "hidden" });
  } finally {
    await studentContext.close();
  }
  await freshForm.getByRole("button", { name: "Cancel", exact: true }).click();
  const emptyDiscovery = handoffPage.waitForResponse(
    (res) => res.url().includes("/bulk-imports?limit=20") && res.status() === 200,
  );
  await handoffPage.getByRole("button", { name: "Add Accounts", exact: true }).click();
  assert.equal(
    (await (await emptyDiscovery).json()).items.filter((item) => item.hasDownload).length,
    0,
  );
  assert.equal(await fileButton.count(), 0);
  await captureAdminPreview(handoffPage, "fresh-browser-no-login-file", freshForm);
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
