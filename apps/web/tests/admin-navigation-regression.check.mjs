import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const server = process.argv[2]
  ? null
  : await createServer({
      cacheDir: "test-results/vite-admin-navigation",
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [resolve("../.."), realpathSync("node_modules")] },
      },
      logLevel: "error",
    });
await server?.listen();
const origin = process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser({ target: origin });
after(async () => {
  await browser.close();
  await server?.close();
});

const project = {
  projectId: "00000000-0000-4000-8000-000000000003",
  title: "Source",
  revision: 0,
  updatedAt: "2026-11-01T00:00:00Z",
  archived: false,
  permissions: { canEdit: true, canManage: true, canPublish: false },
};
const assets = ["model", "environment"].flatMap((kind) =>
  Array.from({ length: 4 }, (_, index) => ({
    id: `${kind}-${index}`,
    name: `${kind === "model" ? "Asset" : "Space"} ${index + 1}`,
    kind,
    category: kind === "model" ? "Objects" : null,
    status: "approved",
    hidden: false,
    deleted: false,
    removedFromProjects: false,
    thumbnail: "/home/assets/default-project-neutral.jpg",
    validation: [],
    actions: ["hide", "delete"],
  })),
);
async function setup(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(3000);
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: "00000000-0000-4000-8000-000000000001",
          displayName: "Admin",
          role: "Administrator",
          orgId: null,
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({ json: { items: [project], nextCursor: null } });
    if (path === "/api/v1/admin/organizations")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v1/admin/assets")
      return route.fulfill({
        json: {
          assets,
          policy: {
            extensions: [".glb"],
            maxBytes: 20971520,
            categories: { environment: null, model: ["Objects"] },
            canSubmit: true,
            canForceRemove: false,
          },
        },
      });
    return route.fulfill({ status: 404 });
  });
  return page;
}

for (const [label, path, heading] of [
  ["View Environments", "/spaces", "All 3D Spaces"],
  ["View Library", "/assets", "All Assets"],
]) {
  test(`${label} navigates to a full page and closes to dashboard`, async () => {
    const page = await setup();
    try {
      await page.goto(origin + "/admin/dashboard");
      await page.getByRole("heading", { name: "Welcome Back, Admin" }).waitFor();
      await page.getByText(label, { exact: true }).click();
      await page.waitForURL(origin + path);
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page.getByRole("button", { name: "Close asset administration" }).click();
      await page.waitForURL(origin + "/admin/dashboard");
    } finally {
      await page.close();
    }
  });
  for (const width of [1440, 390]) {
    test(`${path} direct route hides workspace navigation at ${width}px`, async () => {
      const page = await setup(width);
      try {
        await page.goto(origin + path);
        await page.getByRole("heading", { name: heading, exact: true }).waitFor();
        await page.locator(".asset-admin-card").first().waitFor();
        assert.equal(await page.locator(".asset-admin-card").count(), 4);
        await page
          .locator(".asset-admin-card .asset-admin-thumbnail img")
          .first()
          .evaluate((image) => image.decode());
        assert.equal(await page.getByRole("navigation", { name: "Workspace screens" }).count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (process.env.CHECK_SCREENSHOTS) {
          await mkdir("test-results/admin-navigation", { recursive: true });
          await page.screenshot({
            path: `test-results/admin-navigation/${path.slice(1)}-${width}.png`,
            fullPage: true,
          });
        }
        await page.getByRole("button", { name: "Close asset administration" }).click();
        await page.waitForURL(origin + "/admin/dashboard");
      } finally {
        await page.close();
      }
    });
  }
}
test("dashboard project cover loads the default blank environment image", async () => {
  const page = await setup();
  try {
    await page.goto(origin + "/admin/dashboard");
    await page.getByRole("heading", { name: "Welcome Back, Admin" }).waitFor();
    await page.getByRole("button", { name: "View All Projects" }).click();
    await page
      .locator('section[aria-label="All Projects"]')
      .getByRole("button", { name: "View details for Source" })
      .waitFor();
    const cover = page.locator(".admin-project-card").first().locator("img.admin-project-cover");
    assert.equal(await cover.count(), 1, "project card has a cover image");
    assert.match(
      await cover.getAttribute("src"),
      /default-project-neutral(?:-[\w-]+)?\.jpg(?:\?|$)/,
    );
    await cover.evaluate((image) => image.decode());
    assert.equal(await cover.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    assert.equal(await page.getByText("No cover image").count(), 0);
  } finally {
    await page.close();
  }
});
test("administrator project workspace exposes access management control", async () => {
  const page = await setup();
  try {
    await page.goto(origin + "/home");
    await page.getByRole("heading", { name: "Source", exact: true }).waitFor();
    const cover = page.locator("img.sp-home-project-cover").first();
    assert.match(
      await cover.getAttribute("src"),
      /default-project-neutral(?:-[\w-]+)?\.jpg(?:\?|$)/,
    );
    await cover.evaluate((image) => image.decode());
    assert.equal(await cover.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    if (process.env.CHECK_SCREENSHOTS) {
      await mkdir("test-results/admin-navigation", { recursive: true });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({
          path: `test-results/admin-navigation/neutral-cover-${width}.png`,
          fullPage: true,
        });
      }
    }
    assert.equal(await page.getByRole("button", { name: "Manage access" }).count(), 1);
  } finally {
    await page.close();
  }
});
