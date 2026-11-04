import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

assert.ok(process.env.SPATIA_API_ORIGIN && process.env.SPATIA_TEST_ADMIN);
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const origin = `https://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser({ target: origin });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
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
  await page.getByRole("heading", { name: /Welcome Back,/ }).waitFor();
  await page
    .getByRole("button", { name: "View details for Dashboard browser project", exact: true })
    .click();
  const projectDetails = page.getByRole("dialog", { name: "Project details", exact: true });
  assert.equal(await projectDetails.locator("dd").nth(1).textContent(), "0");
  assert.match(
    await projectDetails
      .getByRole("link", { name: "Open project", exact: true })
      .getAttribute("href"),
    /^\/\?projectId=[0-9a-f-]{36}$/,
  );
  await projectDetails.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  await page
    .getByLabel("Organisation name", { exact: true })
    .fill("Dashboard browser organisation");
  await page.getByRole("button", { name: "Create organisation", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Dashboard browser organisation was created." })
    .waitFor();
  await page.getByRole("link", { name: "View Organisations", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "+ Add Accounts" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Browser Created");
  await dialog.getByLabel("Username", { exact: true }).fill("browser.created");
  await dialog.getByLabel("Password", { exact: true }).fill("Browser-initial1!");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "View account for Browser Created" }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("Password", { exact: true }).inputValue(), "");
  for (const field of ["name", "username", "account type", "password"])
    await dialog.getByRole("button", { name: `Override ${field}`, exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Browser Updated");
  await dialog.getByLabel("Username", { exact: true }).fill("browser.updated");
  await dialog.getByLabel("Account Type", { exact: true }).selectOption("Educator");
  await dialog.getByLabel("New password", { exact: true }).fill("Browser-replacement2!");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "View account for Browser Updated" }).waitFor();
  // Exercise recovery against the real API, failing only the organisation refresh.
  let failOrganizations = true;
  await page.route(/\/api\/admin\/organizations(?:\?|$)/, (route) =>
    failOrganizations
      ? route.fulfill({ status: 503, json: { code: "directory_unavailable" } })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Refresh directory", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "directory request failed" }).waitFor();
  failOrganizations = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "View account for Browser Updated" }).waitFor();
  await page.getByText("Dashboard browser project", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Refresh directory", exact: true }).isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "All organisations", exact: true }).click();
  await page.getByRole("button", { name: "Open Synthetic organization" }).click();
  await page.getByRole("button", { name: "View account for Browser Updated" }).waitFor();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: /Loading/ })
      .count(),
    0,
  );
  const owner = await browser.newContext({ ignoreHTTPSErrors: true });
  const login = await owner.newPage();
  await login.goto(origin + "/login");
  await login.getByLabel("Username", { exact: true }).fill("browser.updated");
  await login.getByLabel("Password", { exact: true }).fill("Browser-replacement2!");
  await login.getByRole("button", { name: "Log in", exact: true }).click();
  await login.getByRole("heading", { name: "Change your password." }).waitFor();
  const session = await login.evaluate(async () => (await fetch("/api/auth/session")).json());
  assert.equal(session.displayName, "Browser Updated");
  assert.equal(session.role, "Educator");
  assert.equal(session.mustChangePassword, true);
  await owner.close();
  console.log(
    "Real API browser test passed: admin login, dashboard, organisation creation, accounts, overrides and failed-refresh recovery.",
  );
} finally {
  await browser.close();
  await server.close();
}
