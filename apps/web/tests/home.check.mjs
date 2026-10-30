import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
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
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/auth/session")
      return route.fulfill(account ? { json: account } : { status: 401 });
    if (path === "/api/auth/csrf") return route.fulfill({ json: { requestToken: "test-token" } });
    if (path === "/api/auth/logout") {
      account = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/projects")
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
    if (path === `/api/projects/${projectId}/duplicate`) {
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
    if (path === `/api/projects/${projectId}/archive`) {
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
  await page.getByRole("heading", { name: "Log in to your workspace" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "The Silk Road" }).count(), 0);
  account = { ...session, mustChangePassword: true };
  await page.reload();
  await page.getByRole("heading", { name: "Change your password to continue" }).waitFor();
  account = session;
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + "/home");
    await page.getByRole("heading", { name: "The Silk Road", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Continue editing" }).isDisabled(), true);
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
    await page.screenshot({ path: `${screenshotDirectory}/projects-${width}.png`, fullPage: true });
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
  await page.getByRole("heading", { name: "Log in to your workspace" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Student draft" }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Home session gates, permission controls, lifecycle outcomes, recovery from unknown responses and four responsive widths passed.",
  );
} finally {
  await browser.close();
}
