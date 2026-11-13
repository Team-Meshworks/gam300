import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const projectId = "aefea67c-caca-4300-923c-937f1c785578";
const assetId = "bbf2b1d0-b388-4df8-a995-930148dcdd19";
const session = {
  userId,
  orgId: null,
  role: "Administrator",
  displayName: "Admin",
  mustChangePassword: false,
};
// Exercise the legacy creation component independently of role dashboards.
try {
  await mkdir("../../.artifacts/project-creation", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(7000);
  async function chooseSpace(value) {
    const field = dialog.getByRole("combobox", { name: /3D space/ });
    if (await field.evaluate((node) => node.tagName === "SELECT")) return field.selectOption(value);
    await field.click();
    await page.getByRole("option", { name: "Gallery", exact: true }).click();
  }
  let account = session;
  let assets = [
    {
      id: assetId,
      name: "Gallery",
      kind: "environment",
      category: null,
      url: `/api/v1/assets/${assetId}/bytes`,
      sha256: "a".repeat(64),
      thumbnail: null,
    },
  ];
  let failAssets = false;
  let organizations = [
    {
      id: orgId,
      name: "Active school",
      isActive: true,
      projectCount: 0,
      facilitatorCount: 0,
      creatorCount: 0,
    },
  ];
  let loseResponse = false;
  let releasePending;
  let holdPending = false;
  const writes = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/session") return route.fulfill({ json: account });
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (path === "/api/v1/classes") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v1/assets")
      return failAssets ? route.fulfill({ status: 503 }) : route.fulfill({ json: assets });
    if (path === "/api/v1/admin/organizations")
      return route.fulfill({
        json: { items: organizations, nextCursor: null },
      });
    if (path === "/api/v1/projects" && request.method() === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v1/projects" && request.method() === "POST") {
      assert.equal(request.headers()["x-csrf-token"], "test-token");
      writes.push(request.postDataJSON());
      if (holdPending) await new Promise((resolve) => (releasePending = resolve));
      if (loseResponse) return route.abort();
      return route.fulfill({
        status: 201,
        json: { projectId, revision: 0, updatedAt: "2026-11-05T00:00:00Z", archived: false },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/home");
  await page.getByRole("heading", { name: "All Projects", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "New project", exact: true }).count(), 0);
  await page.route("**/home/ProjectHome.tsx*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const legacyCreation = 'showCreation && session.role !== "Administrator"';
    assert.ok(source.includes(legacyCreation), "The legacy creation host must remain available");
    await route.fulfill({ response, body: source.replace(legacyCreation, "showCreation") });
  });
  await page.goto(origin + "/home");
  const create = page.getByRole("button", { name: "New project", exact: true });
  await create.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent.trim() === "New project" && !button.disabled,
    ),
  );
  await create.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel("Project title").evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog
      .getByRole("combobox", { name: /3D space/ })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await dialog.getByLabel("Project title").fill("My gallery");
  await chooseSpace(assetId);
  await dialog.getByLabel("Organisation").selectOption(orgId);
  assert.equal(
    await dialog
      .getByText(
        "Empty projects can be edited and assigned, but publishing is not yet available.",
        { exact: true },
      )
      .count(),
    0,
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `../../.artifacts/project-creation/dialog-${width}.png` });
  }
  await page.route(`**/?projectId=${projectId}`, (route) => route.fulfill({ body: "editor" }));
  holdPending = true;
  const pendingRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/v1/projects" && request.method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create project" }).click();
  await pendingRequest;
  assert.equal(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      `spatia:uncertain-project-creation:${userId}`,
    ),
    "1",
    "Recovery marker must be persisted before the create request is sent",
  );
  releasePending();
  holdPending = false;
  await page.waitForURL(`**/?projectId=${projectId}`);
  assert.deepEqual(writes[0], { title: "My gallery", environmentAssetId: assetId, orgId });
  await page.goto(origin + "/home");
  await create.click();
  await dialog.getByLabel("Project title").fill("Unsent project");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog", { name: "Discard new project details?" }).waitFor();
  await page.getByRole("button", { name: "Keep editing" }).click();
  assert.equal(await dialog.getByLabel("Project title").inputValue(), "Unsent project");
  loseResponse = true;
  await chooseSpace(assetId);
  await dialog.getByLabel("Organisation").selectOption(orgId);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.getByText(/could not be confirmed/i).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Create project" }).isDisabled(), true);
  assert.equal(writes.length, 2);
  await dialog.getByRole("button", { name: "Back to projects" }).click();
  assert.equal(await create.isDisabled(), true);
  await page.reload();
  await page.getByRole("button", { name: /checked my projects/i }).waitFor();
  assert.equal(await create.isDisabled(), true);
  await page.getByRole("button", { name: /checked my projects/i }).click();
  account = { ...session, role: "Administrator", orgId: null };
  loseResponse = false;
  await page.goto(origin + "/home");
  await create.click();
  await dialog.getByLabel("Project title").fill("School gallery");
  await chooseSpace(assetId);
  await dialog.getByLabel("Organisation").selectOption(orgId);
  holdPending = true;
  const adminPending = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/v1/projects" && request.method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create project" }).click();
  await adminPending;
  assert.equal(
    await page.getByRole("button", { name: "Back to dashboard", includeHidden: true }).isDisabled(),
    true,
  );
  assert.equal(new URL(page.url()).pathname, "/home");
  releasePending();
  holdPending = false;
  await page.waitForURL(`**/?projectId=${projectId}`);
  assert.deepEqual(writes[2], { title: "School gallery", environmentAssetId: assetId, orgId });
  assets = [];
  organizations = [];
  await page.goto(origin + "/home");
  await page.getByText("An active organisation is required to create a project.").waitFor();
  assert.equal(await create.isDisabled(), true);
  organizations = [
    {
      id: orgId,
      name: "Active school",
      isActive: true,
      projectCount: 0,
      facilitatorCount: 0,
      creatorCount: 0,
    },
  ];
  await page.goto(origin + "/home");
  await page.getByText(/start with an empty scene/i).waitFor();
  assert.equal(await create.isEnabled(), true);
  failAssets = true;
  await page.reload();
  await page.getByText(/spaces.*(?:unavailable|could not|couldn.t)/i).waitFor();
  assert.equal(await create.isEnabled(), true);
  await create.click();
  await dialog.getByRole("combobox", { name: /3D space/ }).click();
  assert.equal(await page.getByRole("option", { name: "Empty scene", exact: true }).count(), 1);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const retry = page.getByRole("button", { name: /retry spaces/i });
  assert.equal(await retry.isEnabled(), true);
  failAssets = false;
  assets = [{ id: assetId, name: "Gallery", kind: "environment" }];
  await retry.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent.trim() === "New project" && !button.disabled,
    ),
  );
  assert.equal(writes.length, 3);
  await create.click();
  await dialog.getByLabel("Project title").fill("Storage failure");
  await chooseSpace(assetId);
  await dialog.getByLabel("Organisation").selectOption(orgId);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  await dialog.getByRole("button", { name: "Create project" }).click();
  await dialog.getByText(/could not safely store/i).waitFor();
  assert.equal(writes.length, 3, "No request is sent when recovery state cannot be stored");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Discard details" }).click();
  await page.reload();
  await create.click();
  await dialog.getByLabel("Project title").fill("Pending on reload");
  await chooseSpace(assetId);
  await dialog.getByLabel("Organisation").selectOption(orgId);
  holdPending = true;
  const interrupted = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/v1/projects" && request.method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create project" }).click();
  await interrupted;
  page.once("dialog", (browserDialog) => browserDialog.accept());
  await page.reload();
  releasePending();
  await page.getByRole("button", { name: /checked my projects/i }).waitFor();
  assert.equal(await create.isDisabled(), true);
  console.log("Project creation opens the confirmed server project");
} finally {
  await browser.close();
}
