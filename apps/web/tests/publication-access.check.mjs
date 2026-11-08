import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const projectId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const otherProject = "6ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const publicationId = "1ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const actor = "8ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const viewer = "9ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const session = {
  userId: actor,
  role: "Educator",
  displayName: "Teacher",
  orgId: otherProject,
  mustChangePassword: false,
};
let currentSession = session;
let access = {
  publicationId,
  projectId,
  audience: "Authenticated",
  explanation: "Only permitted accounts can open this publication after signing in",
  viewerIds: [viewer],
  hidden: false,
  revoked: false,
  deleted: false,
  archived: false,
  canManage: true,
};
let result = "success";
const writes = [];
let reads = 0;
const browser = await launchBrowser({ target: origin });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/session") return route.fulfill({ json: currentSession });
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test" } });
    if (path === `/api/v1/projects/${projectId}`)
      return route.fulfill({
        json: {
          projectId,
          revision: 4,
          document: { title: "Saved exhibition" },
          permissions: { canPublish: true, canManage: true },
        },
      });
    if (path === `/api/v1/projects/${projectId}/publication-readiness`)
      return route.fulfill({
        json: { projectId, revision: 4, state: "Ready", completionConfirmed: true, approved: true },
      });
    if (path === `/api/v1/projects/${projectId}/publication-viewers`)
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === `/api/v1/publications/${publicationId}/access`) {
      if (request.method() === "GET") {
        reads += 1;
        return route.fulfill({ json: access });
      }
      assert.equal(request.method(), "POST");
      writes.push({ path, body: request.postDataJSON() });
      if (result === "unknown") return route.abort();
      access = { ...access, revoked: true };
      return route.fulfill({ status: 204 });
    }
    if (request.method() !== "GET") writes.push({ path, method: request.method() });
    return route.fulfill({ status: 404 });
  });

  await page.goto(`${origin}/publish?projectId=${projectId}`);
  await page.getByRole("heading", { name: "Publish project" }).waitFor();
  const section = page.getByRole("region", { name: "Manage publication access" });
  const input = section.getByRole("textbox", { name: "Publication link or ID" });
  const check = section.getByRole("button", { name: "Check access" });
  await input.fill(`https://spatia.example/p/${publicationId}`);
  await input.focus();
  await page.keyboard.press("Tab");
  assert.equal(await check.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  await section
    .getByText(/authenticated/i)
    .first()
    .waitFor();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Access controls must fit the viewport",
  );
  if (process.env.SPATIA_ACCESS_SCREENSHOT)
    await section.screenshot({ path: process.env.SPATIA_ACCESS_SCREENSHOT });
  const revoke = section.getByRole("button", { name: "Revoke access" });
  await revoke.focus();
  await page.keyboard.press("Enter");
  const confirmation = section.getByRole("group", { name: "Confirm revocation" });
  await confirmation.waitFor();
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  await page.keyboard.press("Tab");
  assert.equal(await cancel.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await confirmation.count(), 0);
  assert.equal(writes.length, 0, "Cancelling must not send a write");

  await revoke.click();
  const beforeRevokeReads = reads;
  await confirmation.getByRole("button", { name: "Confirm revoke" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await section.getByText("Access revoked", { exact: true }).waitFor();
  assert.ok(reads > beforeRevokeReads, "Success must be verified with a fresh access read");
  assert.deepEqual(writes, [
    {
      path: `/api/v1/publications/${publicationId}/access`,
      body: { audience: "Authenticated", viewerIds: [viewer], action: "revoke" },
    },
  ]);

  access = { ...access, revoked: false, canManage: false };
  await check.click();
  await section
    .getByText(/authenticated/i)
    .first()
    .waitFor();
  assert.equal(await revoke.count(), 0, "A non-manager must not see revoke controls");
  access = { ...access, canManage: true, projectId: otherProject };
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith(`/publications/${publicationId}/access`),
    ),
    check.click(),
  ]);
  await section.getByRole("alert").waitFor();
  assert.equal(await revoke.count(), 0, "Another project's publication must not expose controls");

  access = { ...access, projectId };
  await check.click();
  await revoke.click();
  result = "unknown";
  await confirmation.getByRole("button", { name: "Confirm revoke" }).click();
  await section.getByRole("button", { name: "Refresh access" }).waitFor();
  assert.equal(
    await section.getByText("Access revoked", { exact: true }).count(),
    0,
    "An uncertain write must not claim success",
  );
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every((write) => write.path === `/api/v1/publications/${publicationId}/access`),
    "No unrelated publication may be changed",
  );
  result = "success";
  await section.getByRole("button", { name: "Refresh access" }).click();
  await revoke.click();
  currentSession = { ...session, userId: viewer };
  await confirmation.getByRole("button", { name: "Confirm revoke" }).click();
  await section.getByRole("alert").waitFor();
  assert.equal(writes.length, 2, "An account change must prevent the write");
  console.log("Publication access checks passed.");
} finally {
  await browser.close();
}
