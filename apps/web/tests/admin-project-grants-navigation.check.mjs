import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const server = await createServer({
  cacheDir: "test-results/vite-admin-project-grants-navigation",
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
    if (path === "/api/v1/projects")
      return route.fulfill({
        json: {
          items: [
            {
              projectId: "33333333-3333-4333-8333-333333333333",
              title: "Grant browser project",
              revision: 0,
              updatedAt: "2026-11-01T00:00:00Z",
              archived: false,
              permissions: { canEdit: true, canManage: true, canPublish: true },
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`${origin}/admin/dashboard`);
  assert.equal(await page.getByRole("link", { name: "Open project workspace" }).count(), 0);
  await page.goto(`${origin}/home`);
  const project = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Grant browser project", exact: true }),
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const access = project.getByRole("button", { name: "Manage access", exact: true });
    await access.focus();
    assert.equal(await access.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Project access" }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Project access" }).waitFor({ state: "detached" });
  }
} finally {
  await browser?.close();
  await server.close();
}
