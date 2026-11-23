import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const server = await createServer({
  cacheDir: "test-results/vite-admin-classes-navigation",
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  page.setDefaultNavigationTimeout(30000);
  const classId = "22222222-2222-4222-8222-222222222222";
  const sourceId = "33333333-3333-4333-8333-333333333333";
  const assignmentPosts = [];
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: "11111111-1111-4111-8111-111111111111",
          displayName: "Admin",
          role: "Administrator",
          orgId: null,
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/classes")
      return route.fulfill({
        json: {
          items: [{ id: classId, name: "History", organizationId: classId }],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({
        json: {
          items: [
            {
              projectId: sourceId,
              title: "Source museum",
              revision: 1,
              updatedAt: "2026-11-23T01:00:00Z",
              archived: false,
              permissions: { canManage: true, canEdit: false, canPublish: false },
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/eligible-students"))
      return route.fulfill({
        json: {
          items: [{ userId: sourceId, userName: "Learner", enrolled: true }],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "isolated-admin-assignment-csrf" } });
    if (path.endsWith("/assignments") && route.request().method() === "POST") {
      assignmentPosts.push(route.request().postDataJSON());
      return route.abort("failed");
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`${origin}/admin/dashboard`);
  assert.equal(await page.getByRole("link", { name: "Open project workspace" }).count(), 0);
  await page.goto(`${origin}/home`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const classes = page.getByRole("button", { name: "Classes", exact: true });
    await classes.focus();
    assert.equal(await classes.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    const classControl = page.getByRole("combobox", { name: "Class", exact: true });
    await classControl.click();
    await page.getByRole("option", { name: "History", exact: true }).click();
    assert.equal((await classControl.innerText()).trim(), "History");
    assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("button", { name: "Projects", exact: true }).click();
  }
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  const sourceControl = page.getByRole("combobox", { name: "Source project *", exact: true });
  await sourceControl.click();
  await page.getByRole("option", { name: "Source museum", exact: true }).click();
  const assignmentClass = page.getByRole("combobox", { name: "Class *", exact: true });
  await assignmentClass.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal((await assignmentClass.innerText()).trim(), "History");
  assert.equal((await sourceControl.innerText()).trim(), "Source museum");
  assert.equal(await page.locator("select").count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("textbox", { name: /^Project title/ }).fill("Admin assignment");
  await page
    .getByRole("textbox", { name: /^Project description/ })
    .fill("Preserve the selected class and source.");
  await page.getByRole("textbox", { name: /^Project instructions/ }).fill("Build an exhibit.");
  await page.getByLabel(/^Due date/).fill("2099-12-01T15:30");
  await page.getByRole("checkbox", { name: /Learner/ }).check();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry same assignment", exact: true });
  await retry.waitFor();
  assert.equal(assignmentPosts.length, 1);
  assert.equal(assignmentPosts[0].sourceProjectId, sourceId);
  assert.equal((await sourceControl.innerText()).trim(), "Source museum");
  assert.equal((await assignmentClass.innerText()).trim(), "History");
  assert.ok(await sourceControl.isDisabled());
  assert.ok(await assignmentClass.isDisabled());
  await retry.click();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Create class assignment"] button')?.disabled,
  );
  assert.equal(assignmentPosts.length, 2);
  assert.deepEqual(assignmentPosts[1], assignmentPosts[0]);
  console.log(
    "Admin dropdown navigation and assignment selection survive uncertain writes and identical retries.",
  );
} finally {
  await browser?.close();
  await server.close();
}
