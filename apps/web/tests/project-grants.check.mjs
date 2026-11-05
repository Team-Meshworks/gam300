import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const administrator = "00000000-0000-4000-8000-000000000001";
const organization = "00000000-0000-4000-8000-000000000002";
const project = "00000000-0000-4000-8000-000000000003";
const educator = "00000000-0000-4000-8000-000000000004";
const creator = "00000000-0000-4000-8000-000000000005";
const session = {
  userId: administrator,
  displayName: "Admin",
  orgId: null,
  role: "Administrator",
  mustChangePassword: false,
};
let actor = session;
let writes = 0;
let mode = "ok";
let revision = 3;
let publish = false;
let unsupported = false;
let releaseWrite;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/auth/session") return json(actor);
    if (path === "/api/auth/csrf") return json({ requestToken: "token" });
    if (path === "/api/projects")
      return json({
        items: [
          {
            projectId: project,
            title: "Source",
            revision,
            updatedAt: "2026-11-01T00:00:00Z",
            archived: false,
            permissions: { canEdit: true, canManage: true, canPublish: true },
          },
        ],
        nextCursor: null,
      });
    if (path === `/api/projects/${project}/assignments`) {
      assert.equal(request.headers()["x-spatia-account"], administrator);
      if (request.method() === "PATCH") {
        writes++;
        assert.deepEqual(request.postDataJSON(), {
          expectedRevision: revision,
          managedByUserIds: [educator],
          assignedCreatorIds: [creator],
          canPublishUserIds: [creator],
        });
        if (mode === "hold") {
          await new Promise((resolve) => {
            releaseWrite = resolve;
          });
          return json({}, 409);
        }
        if (mode === "unknown") return route.abort("failed");
        revision++;
        publish = true;
        return json({
          projectId: project,
          revision,
          updatedAt: "2026-11-01T00:00:00Z",
          archived: false,
        });
      }
      return json({
        projectId: project,
        organizationId: organization,
        revision,
        archived: false,
        assignments: [
          { userId: educator, canEdit: true, canManage: true, canPublish: !unsupported },
          { userId: creator, canEdit: true, canManage: false, canPublish: publish },
        ],
      });
    }
    if (path === "/api/admin/organizations")
      return json({
        items: [{ id: organization, name: "School", isActive: true }],
        nextCursor: null,
      });
    if (path === "/api/admin/users")
      return json({
        items: [
          {
            userId: educator,
            displayName: "Educator",
            userName: "educator",
            role: "Educator",
            orgId: organization,
            isActive: true,
            mustChangePassword: false,
          },
          {
            userId: creator,
            displayName: "Creator",
            userName: "creator",
            role: "Creator",
            orgId: organization,
            isActive: true,
            mustChangePassword: false,
          },
        ],
        nextCursor: null,
      });
    return json({}, 404);
  });
  await page.goto(`${origin}/home`);
  await page.getByRole("heading", { name: "Source", exact: true }).waitFor();
  await page.getByRole("button", { name: "Manage access" }).click();
  let dialog = page.getByRole("dialog", { name: "Project access" });
  await dialog.waitFor();
  const manager = () =>
    dialog.getByRole("checkbox", { name: "Manage access for Educator (educator)" });
  const edit = () => dialog.getByRole("checkbox", { name: "Edit project for Creator (creator)" });
  const publishBox = () =>
    dialog.getByRole("checkbox", { name: "Publish project for Creator (creator)" });
  assert.equal(await manager().isChecked(), true);
  assert.equal(await edit().isChecked(), true);
  assert.equal(await publishBox().isChecked(), false);
  await mkdir("../../.artifacts/grant-check", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `../../.artifacts/grant-check/access-${width}.png`,
      fullPage: true,
    });
  }
  await manager().focus();
  await page.keyboard.press("Tab");
  assert.equal(await edit().evaluate((element) => document.activeElement === element), true);
  await publishBox().focus();
  await page.keyboard.press("Space");
  assert.equal(await publishBox().isChecked(), true);
  actor = { ...session, mustChangePassword: true };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("heading", { name: "Change your password to continue" }).waitFor();
  await page
    .getByRole("link", { name: "Go to login" })
    .evaluate((link) =>
      link.addEventListener("click", (event) => event.preventDefault(), { once: true }),
    );
  await page.getByRole("link", { name: "Go to login" }).click();
  actor = session;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.equal(await publishBox().isChecked(), true);
  await dialog.getByRole("button", { name: "Reload access" }).click();
  await page
    .getByRole("dialog", { name: "Discard access changes?" })
    .getByRole("button", { name: "Keep editing" })
    .click();
  assert.equal(await publishBox().isChecked(), true);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page
    .getByRole("dialog", { name: "Discard access changes?" })
    .getByRole("button", { name: "Keep editing" })
    .click();
  mode = "hold";
  await dialog.getByRole("button", { name: "Save access" }).click();
  await page.waitForFunction(() => document.querySelector('form[aria-busy="true"]'));
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Close" }).click();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole("button", { name: "Saving access…" }).isDisabled(), true);
  assert.equal(writes, 1);
  releaseWrite();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await publishBox().isChecked(), true);
  mode = "unknown";
  await dialog.getByRole("button", { name: "Save access" }).click();
  await dialog.getByRole("alert").filter({ hasText: "could not confirm" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Save access" }).isDisabled(), true);
  assert.equal(writes, 2);
  await dialog.getByRole("button", { name: "Reload access" }).click();
  assert.equal(await publishBox().isChecked(), false);
  await publishBox().check();
  mode = "ok";
  await dialog.getByRole("button", { name: "Save access" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(writes, 3);
  await page.getByRole("button", { name: "Manage access" }).click();
  dialog = page.getByRole("dialog", { name: "Project access" });
  assert.equal(await publishBox().isChecked(), true);
  await dialog.getByRole("button", { name: "Close" }).click();
  unsupported = true;
  await page.getByRole("button", { name: "Manage access" }).click();
  await page.getByRole("alert").filter({ hasText: "cannot be edited" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save access" }).count(), 0);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  actor = { ...session, userId: educator, role: "Educator", orgId: organization };
  await page.reload();
  await page.getByRole("heading", { name: "Source", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Manage access" }).count(), 0);
  assert.equal(writes, 3);
  console.log("Project access preservation, recovery and role gates passed");
} finally {
  await browser.close();
}
