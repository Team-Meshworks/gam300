import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const server = process.argv[2]
  ? null
  : await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server?.listen();
const origin = process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser({ target: origin });
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const otherId = "5db2e0d8-d85f-420a-b0fd-ef4f78d1cb10";
const admin = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const name = "Ridgeview Secondary School";
let failPreview = false;
let failDelete = true;
let releaseDelete;
let deletes = 0;
let deleted = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: admin,
          displayName: "Administrator",
          role: "Administrator",
          orgId: null,
          mustChangePassword: false,
        },
      });
    assert.equal(request.headers()["x-spatia-account"], admin);
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test-csrf" } });
    if (request.method() === "DELETE") {
      assert.equal(path, `/api/v1/admin/organizations/${orgId}`);
      assert.equal(request.headers()["x-csrf-token"], "test-csrf");
      assert.deepEqual(request.postDataJSON(), { confirmationName: name });
      deletes++;
      if (failDelete)
        return route.fulfill({ status: 409, json: { code: "organization_delete_conflict" } });
      await new Promise((resolve) => {
        releaseDelete = resolve;
      });
      deleted = true;
      return route.fulfill({ status: 204 });
    }
    assert.equal(request.method(), "GET");
    if (path === `/api/v1/admin/organizations/${orgId}/deletion`)
      return failPreview
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({
            json: {
              id: orgId,
              name,
              accounts: 3,
              classes: 1,
              assignments: 2,
              projects: 4,
              submissions: 2,
              reviews: 1,
              publications: 1,
            },
          });
    if (path === "/api/v1/admin/organizations")
      return route.fulfill({
        json: {
          items: [
            ...(!deleted
              ? [
                  {
                    id: orgId,
                    name,
                    isActive: true,
                    projectCount: 4,
                    facilitatorCount: 1,
                    creatorCount: 2,
                  },
                ]
              : []),
            {
              id: otherId,
              name: "Other school",
              isActive: true,
              projectCount: 0,
              facilitatorCount: 0,
              creatorCount: 0,
            },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/admin/users" || path.endsWith("/projects"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/organisations`);
  await page.getByRole("button", { name: `Open ${name}` }).click();
  const open = page.getByRole("button", { name: "Delete organisation", exact: true });
  await open.click();
  let dialog = page.getByRole("dialog");
  await dialog.getByText("3 accounts", { exact: true }).waitFor();
  assert.match(await dialog.innerText(), /This cannot be undone/);
  assert.match(await dialog.innerText(), /including archived projects/);
  const confirm = dialog.getByRole("button", { name: "Delete Organisation Permanently" });
  assert.equal(await confirm.isDisabled(), true);
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name.toLowerCase());
  assert.equal(await confirm.isDisabled(), true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(deletes, 0);

  failPreview = true;
  await open.click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Delete Organisation Permanently" }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  failPreview = false;
  await open.click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  await dialog.getByRole("button", { name: "Delete Organisation Permanently" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.getByRole("alert").innerText(), /Nothing was deleted/);
  assert.equal(deletes, 1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open.click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("3 accounts", { exact: true }).waitFor();
  const screenshot =
    process.env.CHECK_SCREENSHOT ?? "test-results/organization-deletion-mobile.png";
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  failDelete = false;
  await dialog.getByRole("button", { name: "Delete Organisation Permanently" }).click();
  await dialog.getByRole("button", { name: "Deleting…" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Deleting…" }).isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(deletes, 2);
  releaseDelete();
  await page
    .getByText(`${name} and its accounts and workspace data were deleted.`, { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByRole("button", { name: `Open ${name}` }).count(), 0);
  await page.getByRole("button", { name: "Open Other school" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Open Other school" }).waitFor();
  assert.equal(await page.getByRole("button", { name: `Open ${name}` }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Organization deletion browser checks passed: confirmation, cancellation, failure, pending state, mobile, success.",
  );
} finally {
  releaseDelete?.();
  await browser.close();
  await server?.close();
}
