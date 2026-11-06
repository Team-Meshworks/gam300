import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

assert.ok(
  process.env.SPATIA_API_ORIGIN &&
    process.env.SPATIA_TEST_ADMIN &&
    process.env.SPATIA_TEST_CREATOR &&
    process.env.SPATIA_TEST_PROJECT,
);
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const origin = `https://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await launchBrowser({ target: origin });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${origin}/login`);
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_ADMIN);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(`${origin}/admin/dashboard`);
  await page.getByRole("link", { name: "View All Projects", exact: true }).click();
  await page.waitForURL(`${origin}/home`);
  await page.getByRole("link", { name: "Organisations", exact: true }).click();
  await page.waitForURL(`${origin}/organisations`);
  await page.getByRole("link", { name: "Close organisations", exact: true }).click();
  await page.waitForURL(`${origin}/admin/dashboard`);
  await page.getByRole("link", { name: "View All Projects", exact: true }).click();
  await page.waitForURL(`${origin}/home`);
  await page.getByRole("heading", { name: "Grant browser project", exact: true }).waitFor();
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project access" });
  await dialog.waitFor();
  const publish = dialog.getByRole("checkbox", {
    name: `Publish project for ${process.env.SPATIA_TEST_CREATOR} (${process.env.SPATIA_TEST_CREATOR})`,
    exact: true,
  });
  assert.equal(await publish.isChecked(), false);
  await publish.check();
  await dialog.getByRole("button", { name: "Save access", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  assert.equal(await publish.isChecked(), true);
  const creatorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const creatorPage = await creatorContext.newPage();
  await creatorPage.goto(`${origin}/login`);
  await creatorPage.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_CREATOR);
  await creatorPage.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await creatorPage.getByRole("button", { name: "Log in", exact: true }).click();
  await creatorPage.getByRole("link", { name: "Go to projects" }).waitFor();
  const denial = await creatorPage.evaluate(async (projectId) => {
    const path = `/api/v1/projects/${projectId}/assignments`;
    const read = await fetch(path);
    const csrf = await (await fetch("/api/v1/auth/csrf")).json();
    const write = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
      body: JSON.stringify({
        expectedRevision: 1,
        managedByUserIds: [],
        assignedCreatorIds: [],
        canPublishUserIds: [],
      }),
    });
    return { read: read.status, write: write.status };
  }, process.env.SPATIA_TEST_PROJECT);
  assert.deepEqual(denial, { read: 403, write: 403 });
  await creatorContext.close();
  await context.close();
  console.log("Real API project access browser test passed");
} finally {
  await browser?.close();
  await server.close();
}
