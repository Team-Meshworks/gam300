import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const projectId = "aefea67c-caca-4300-923c-937f1c785578";
const copyId = "bbf2b1d0-b388-4df8-a995-930148dcdd19";
const session = {
  userId,
  displayName: "TeacherWithALongUnbrokenAccountName".repeat(4),
  orgId,
  role: "Educator",
  mustChangePassword: false,
};
const project = {
  projectId,
  title: "The Silk Road",
  revision: 3,
  updatedAt: "2026-10-30T01:00:00Z",
  archived: false,
  permissions: { canEdit: true, canManage: true, canPublish: true },
};
const screenshotDirectory = "../../.artifacts/home-check";
await mkdir(screenshotDirectory, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let account = session;
  let items = [structuredClone(project)];
  let writes = 0;
  let lostResponse = false;
  let rejectList = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill(account ? { json: account } : { status: 401 });
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (path === "/api/v1/admin/organizations")
      return route.fulfill({
        json: {
          items: [
            { id: orgId, name: "Active school", isActive: true },
            { id: copyId, name: "Inactive school", isActive: false },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/classes" && request.method() === "POST") {
      assert.deepEqual(request.postDataJSON(), { name: "First class", orgId });
      return route.fulfill({
        status: 201,
        json: { id: copyId, name: "First class", organizationId: orgId },
      });
    }
    if (path === "/api/v1/classes") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v1/auth/logout") {
      account = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/projects")
      return route.fulfill(
        rejectList
          ? { status: 403 }
          : {
              json: {
                items: items.filter(
                  (item) => item.archived === (url.searchParams.get("archived") === "true"),
                ),
                nextCursor: null,
              },
            },
      );
    if (path === `/api/v1/projects/${projectId}/duplicate`) {
      writes++;
      assert.equal(request.headers()["x-csrf-token"], "test-token");
      assert.deepEqual(request.postDataJSON(), { expectedRevision: 3, title: "Silk Road copy" });
      items.push({ ...project, projectId: copyId, title: "Silk Road copy", revision: 0 });
      if (lostResponse) return route.abort();
      return route.fulfill({
        status: 201,
        json: { projectId: copyId, revision: 0, updatedAt: project.updatedAt, archived: false },
      });
    }
    if (path === `/api/v1/projects/${projectId}/archive`) {
      writes++;
      assert.equal(request.headers()["x-csrf-token"], "test-token");
      const body = request.postDataJSON();
      const row = items.find((item) => item.projectId === projectId);
      assert.equal(body.expectedRevision, row.revision);
      row.revision++;
      row.archived = body.archived;
      return route.fulfill({
        json: {
          projectId,
          revision: row.revision,
          archived: row.archived,
          updatedAt: row.updatedAt,
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  account = null;
  await page.goto(origin + "/home");
  await page.waitForURL(origin + "/login");
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal(await page.locator(".sp-home-project-card").count(), 0);
  account = { ...session, mustChangePassword: true };
  await page.goto(origin + "/home");
  await page.getByRole("heading", { name: "Change your password to continue" }).waitFor();
  account = session;
  if (process.argv[3] === "legacy-routes") {
    await page.goto(origin + "/classes");
    await page.getByRole("button", { name: "New assignment" }).waitFor();
    await page.goto(origin + "/new-project");
    await page.getByRole("heading", { name: "New class assignment" }).waitFor();
    await page.getByLabel("Project title").fill("Unsent assignment");
    await page.getByRole("button", { name: "Classes", exact: true }).click();
    await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
    await page.getByRole("button", { name: "Keep editing" }).click();
    assert.equal(await page.getByLabel("Project title").inputValue(), "Unsent assignment");
    account = { ...session, role: "Creator" };
    await page.reload();
    await page.getByRole("heading", { name: "Access denied" }).waitFor();
    assert.equal(await page.getByLabel("Project title").count(), 0);
    await page.goto(origin + "/classes");
    await page.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "New assignment" }).count(), 0);
    await page.goto(origin + "/review");
    await page.getByRole("heading", { name: "Submission review" }).waitFor();
    assert.equal(
      await page.getByRole("link", { name: "New class assignment", exact: true }).count(),
      0,
    );
    console.log("Legacy class and assignment routes use the guarded workspace");
  } else if (process.argv[3] === "admin") {
    account = { ...session, role: "Administrator", orgId: null };
    await page.goto(origin + "/home");
    await page.getByRole("button", { name: "Classes", exact: true }).click();
    await page.getByRole("button", { name: "New class" }).click();
    await page.getByLabel("Class name").fill("First class");
    await page
      .getByLabel("Organisation")
      .selectOption({ label: "Active school" }, { timeout: 5000 });
    assert.equal(await page.getByRole("option", { name: "Inactive school" }).count(), 0);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Class change confirmed.").waitFor();
    assert.equal(
      await page.getByRole("link", { name: "Accounts" }).getAttribute("href"),
      "/accounts",
    );
    assert.equal(
      await page.getByRole("link", { name: "Dashboard" }).getAttribute("href"),
      "/admin/dashboard",
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${screenshotDirectory}/admin-${width}.png`, fullPage: true });
    }
    console.log("Administrator creates the first class from an active organisation");
  } else if (process.argv[3] === "open-project") {
    await page.goto(origin + "/home");
    await page.getByRole("heading", { name: "The Silk Road", exact: true }).waitFor();
    await page.route(`**/?projectId=${projectId}`, (route) => route.fulfill({ body: "editor" }));
    await page.getByRole("button", { name: "Continue editing" }).click();
    assert.equal(new URL(page.url()).searchParams.get("projectId"), projectId);
    console.log("Project opens in server editor");
  } else if (process.argv[3] === "gate") {
    await page.goto(origin + "/home");
    await page.getByRole("button", { name: "Classes", exact: true }).click();
    await page.getByRole("button", { name: "New assignment" }).click();
    await page.getByLabel("Project title").fill("Unsent assignment");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
    account = { ...session, mustChangePassword: true };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("heading", { name: "Change your password to continue" }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Leave this page?" }).count(), 0);
    await page.getByRole("link", { name: "Go to login" }).evaluate((link) => {
      link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    });
    await page.getByRole("link", { name: "Go to login" }).click({ timeout: 5000 });
    assert.equal(await page.getByLabel("Project title").isVisible(), false);
    account = session;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "Keep editing" }).click();
    await page.getByLabel("Project title").waitFor();
    assert.equal(await page.getByLabel("Project title").inputValue(), "Unsent assignment");
    account = { ...session, userId: orgId };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("heading", { name: "The Silk Road", exact: true }).waitFor();
    assert.equal(await page.getByText("Unsent assignment").count(), 0);
    console.log("Assignment survives same-actor gate and stays hidden from other actors");
    process.exitCode = 0;
  } else {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + "/home");
      await page.getByRole("heading", { name: "The Silk Road", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Continue editing" }).isDisabled(),
        false,
      );
      assert.equal(
        await page.getByRole("button", { name: "New project", exact: true }).isDisabled(),
        true,
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `home overflows at ${width}`,
      );
      assert.ok(
        await page.getByRole("button", { name: "Log Out", exact: true }).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth;
        }),
        `logout must remain on screen with a long account name at ${width}`,
      );
      for (const image of await page.locator(".sp-shell img").all()) {
        await image.evaluate((element) => element.decode());
        assert.ok(await image.evaluate((element) => element.naturalWidth > 0));
      }
      await page.screenshot({
        path: `${screenshotDirectory}/projects-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("searchbox", { name: "Search projects" }).fill("unrelated");
    await page.getByText("No projects match your search.").waitFor();
    await page.getByRole("searchbox", { name: "Search projects" }).fill("");
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Project archived.", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Archived", exact: true }).click();
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Project reopened.", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    items[0].revision = 3;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await page.getByLabel("Copy title").fill("Silk Road copy");
    lostResponse = true;
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /could not be confirmed/ })
      .waitFor();
    assert.equal(writes, 3, "An uncertain copy is not automatically retried");
    assert.equal(await page.getByRole("button", { name: "Confirm", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("heading", { name: "Silk Road copy", exact: true }).waitFor();
    account = { ...session, userId: orgId, role: "Creator" };
    items = [
      {
        ...project,
        title: "Student draft",
        permissions: { canEdit: true, canManage: false, canPublish: false },
      },
    ];
    await page.reload();
    await page.getByRole("heading", { name: "Student draft" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Archive", exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "The Silk Road" }).count(), 0);
    rejectList = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("heading", { name: "We couldn’t load this view" }).waitFor();
    rejectList = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("heading", { name: "Student draft" }).waitFor();
    await page.getByRole("button", { name: "Log Out", exact: true }).click();
    await page.waitForURL(origin + "/login");
    await page.getByRole("heading", { name: "Welcome back." }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Student draft" }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "Home session gates, permission controls, lifecycle outcomes, recovery from unknown responses and four responsive widths passed.",
    );
  }
} finally {
  await browser.close();
}

if (!process.argv[3]) {
  for (const scenario of ["gate", "open-project", "admin", "legacy-routes"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), origin, scenario], {
      stdio: "inherit",
      env: process.env,
    });
    assert.equal(result.status, 0, `${scenario} browser regression failed`);
  }
}
