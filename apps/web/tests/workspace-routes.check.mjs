import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
const session = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "Test Teacher",
  role: "Educator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  mustChangePassword: false,
};
const screens = [
  ["admin/dashboard", "Welcome Back, Test Teacher"],
  ["new-project", "New Project"],
  ["classes", "Classes"],
  ["organisations", "All Organisations"],
];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "Educator";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    assert.equal(request.method(), "GET", "Workspace routes must not mutate the API");
    if (new URL(request.url()).pathname === "/api/v1/auth/session") {
      if (mode === "anonymous") return route.fulfill({ status: 401 });
      if (mode === "unavailable") return route.fulfill({ status: 503 });
      return route.fulfill({
        status: 200,
        json: {
          ...session,
          role: mode === "forced" ? "Educator" : mode,
          orgId: mode === "Administrator" ? null : session.orgId,
          mustChangePassword: mode === "forced",
        },
      });
    }
    if (new URL(request.url()).pathname === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (new URL(request.url()).pathname === "/api/v1/admin/organizations")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 503 });
  });

  async function screen(path, heading) {
    await page.goto(`${origin}/${path}`);
    await page
      .getByRole("heading", {
        name: heading,
        level: heading === "All Organisations" ? 1 : undefined,
        exact: true,
      })
      .waitFor();
    assert.equal(await page.getByText(/development preview|simulation|ms tan/i).count(), 0);
  }
  for (const [path, heading] of screens) {
    mode = path === "organisations" || path === "admin/dashboard" ? "Administrator" : "Educator";
    await screen(`${path}/?source=check`, heading);
    await page.reload();
    await page
      .getByRole("heading", {
        name: heading,
        level: heading === "All Organisations" ? 1 : undefined,
        exact: true,
      })
      .waitFor();
  }

  mode = "Educator";
  await page.goto(`${origin}/review`);
  await page.waitForURL(`${origin}/home`);

  // Use the mounted screen and authenticated intake adapter, not its local preview.
  mode = "Administrator";
  let assetReads = 0;
  let uploadedMetadata;
  await page.route(/\/api\/v1\/admin\/assets(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      uploadedMetadata = JSON.parse(
        Buffer.from(route.request().headers()["x-spatia-asset-metadata"], "base64").toString(
          "utf8",
        ),
      );
      assert.equal(route.request().headers()["x-csrf-token"], "test-token");
      return route.fulfill({
        status: 201,
        json: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "room",
          kind: "environment",
          category: null,
          status: "approved",
          hidden: false,
          deleted: false,
          removedFromProjects: false,
          thumbnail: null,
          validation: [],
          actions: ["hide", "delete"],
          ...uploadedMetadata,
        },
      });
    }
    assetReads++;
    return route.fulfill({
      json: {
        assets: [],
        policy: {
          extensions: [".glb"],
          maxBytes: 20 * 1024 * 1024,
          categories: { environment: null, model: ["Objects"] },
          canSubmit: true,
          canForceRemove: false,
        },
      },
    });
  });
  await screen("assets", "All Assets");
  await page.getByText("No assets yet", { exact: true }).waitFor();
  await mkdir("test-results/scrum168", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `test-results/scrum168/mounted-assets-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await screen("spaces", "All 3D Spaces");
  assert.ok(assetReads >= 2, "Both admin libraries load the real service route");
  for (const [path, title] of [
    ["spaces", "Upload 3D Space"],
    ["assets", "Upload 3D Model"],
  ]) {
    await page.goto(`${origin}/${path}?add=1`);
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: title, exact: true })
      .waitFor({ timeout: 3000 });
  }
  await page.goto(`${origin}/spaces?add=1`);
  const upload = page.getByRole("dialog");
  await upload.getByLabel("Choose asset file").setInputFiles({
    name: "room.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from("fixture"),
  });
  await upload.getByLabel("Source or provenance (optional)").fill("Museum archive");
  await upload.getByLabel("Redistribution licence (optional)").fill("CC BY 4.0");
  await upload.getByLabel("Content review notes (optional)").fill("Rights checked");
  await upload.getByRole("button", { name: "Save Changes" }).click();
  await upload.waitFor({ state: "hidden" });
  assert.deepEqual(uploadedMetadata, {
    source: "Museum archive",
    license: "CC BY 4.0",
    reviewNotes: "Rights checked",
  });

  // Direct creator and educator routes must not fetch intake data.
  for (const role of ["Creator", "Educator"]) {
    mode = role;
    const before = assetReads;
    await screen("assets", "Access denied");
    await screen("spaces", "Access denied");
    assert.equal(assetReads, before);
  }

  mode = "Educator";
  await screen("new-project", "New Project");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.getByRole("navigation", { name: "Workspace", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Close new project" }).isVisible(), true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Close new project" }).click();
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("heading", { name: "Classes", exact: true }).waitFor();
  await page.getByRole("button", { name: "New assignment" }).click();
  await page.getByRole("heading", { name: "New class assignment" }).waitFor();
  mode = "Creator";
  for (const path of ["new-project", "organisations", "admin/dashboard"]) {
    await screen(path, "Access denied");
  }
  await screen("classes", "Classes");
  assert.equal(await page.getByRole("button", { name: "New assignment" }).count(), 0);
  await screen("review", "Submission review");
  assert.equal(await page.getByRole("link", { name: "New class assignment" }).count(), 0);
  mode = "anonymous";
  for (const path of [
    "home",
    "classes",
    "new-project",
    "review",
    "publish",
    "organisations",
    "assets",
    "spaces",
    "admin/dashboard",
    "?projectId=aefea67c-caca-4300-923c-937f1c785578",
  ]) {
    await page.goto(`${origin}/${path}`);
    const destination = path.startsWith("?projectId=")
      ? `${origin}/login?returnTo=${encodeURIComponent("/" + path)}`
      : `${origin}/login`;
    await page.waitForURL(destination);
    await page.getByRole("heading", { name: "Welcome back.", exact: true }).waitFor();
    assert.equal(await page.locator(".sp-workspace, .editor-shell").count(), 0);
  }
  // Expiry on a mounted workspace redirects too, and Back skips the protected page.
  mode = "Educator";
  await screen("home", "Welcome Back, Test Teacher");
  mode = "anonymous";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(`${origin}/login`);
  await page.goto(`${origin}/landing`);
  await page.goto(`${origin}/home`);
  await page.waitForURL(`${origin}/login`);
  await page.goBack();
  await page.waitForURL(`${origin}/landing`);
  mode = "unavailable";
  await page.goto(`${origin}/classes`);
  await page
    .getByText(/unavailable|try again|could not be verified/i)
    .first()
    .waitFor();
  assert.equal(await page.getByRole("heading", { name: "Classes", exact: true }).count(), 0);
  mode = "forced";
  await page.goto(`${origin}/classes`);
  await page
    .getByText(/change.*password|password.*change/i)
    .first()
    .waitFor();
  assert.equal(await page.getByRole("heading", { name: "Classes", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("Workspace route browser checks passed");
} finally {
  await browser.close();
}
