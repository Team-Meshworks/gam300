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
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`${origin}/admin/dashboard`);
  await page.getByRole("link", { name: "Open project workspace" }).click();
  await page.waitForURL(`${origin}/home`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const classes = page.getByRole("button", { name: "Classes", exact: true });
    await classes.focus();
    assert.equal(await classes.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("button", { name: "Projects", exact: true }).click();
  }
} finally {
  await browser?.close();
  await server.close();
}
