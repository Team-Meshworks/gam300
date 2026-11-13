import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { launchPersistentBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

// Run against a built preview. Real bundled GLBs are delivered by HTTP; only the account
// API is simulated here. Actual Identity/database coverage lives in the HTTPS server suite.
const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5194/").origin;
const manifest = JSON.parse(
  await readFile(new URL("../../../assets/manifest.json", import.meta.url)),
);
const modelPath = (id) =>
  "/restricted-assets/" + manifest.assets.find((a) => a.assetId === id).sha256 + ".glb";
const browser = await launchPersistentBrowser({
  target: origin,
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  const project = await serveProject(page, origin);
  await page.setViewportSize({ width: 1440, height: 1000 });
  let signedIn = false;
  let denyCrate = false;
  const requested = new Set();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith(".glb")) requested.add(new URL(request.url()).pathname);
  });
  await page.route("**/api/v1/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test-csrf" } });
    if (path === "/api/v1/auth/login") {
      signedIn = true;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/auth/session")
      return route.fulfill(
        signedIn
          ? {
              json: {
                userId: "11111111-1111-4111-8111-111111111111",
                displayName: "Browser check",
                role: "Creator",
                orgId: "22222222-2222-4222-8222-222222222222",
                mustChangePassword: false,
                developmentAssetsAllowed: true,
              },
            }
          : { status: 401, json: {} },
      );
    return route.abort();
  });
  await page.route("**/restricted-assets/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return !signedIn || (denyCrate && path === modelPath("test-crate-v1"))
      ? route.fulfill({ status: 401, body: "Session required" })
      : route.continue();
  });
  await page.goto(project.url);
  await page.waitForURL(
    origin +
      `/login?returnTo=${encodeURIComponent(new URL(project.url).pathname + new URL(project.url).search)}`,
  );
  assert.equal(requested.size, 0, "Signed-out entry must not start protected model downloads");
  await page.getByLabel("Username", { exact: true }).fill("browser-check");
  await page.getByLabel("Password", { exact: true }).fill("Synthetic browser password 1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(project.url);
  const ready = () => page.getByText("Scene ready", { exact: true }).waitFor();
  await ready();
  assert.equal(requested.size, 0, "An empty editor must not download the whole catalogue");
  const canvas = page.locator(".viewport-stage canvas");
  const empty = await canvas.screenshot();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page
    .getByRole("group", { name: "Rooms options", exact: true })
    .getByRole("button", { name: "Starter room", exact: true })
    .click();
  await placeAtRoomCenter(page);
  await ready();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "Sample crate", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await placeAtRoomCenter(page);
  await ready();
  assert.equal(await page.locator(".object-row").count(), 1);
  assert.ok(requested.has(modelPath("test-room-v1")));
  assert.ok(requested.has(modelPath("test-crate-v1")));
  assert.ok(
    !requested.has(modelPath("library-untitled-v1")),
    "Unused 94 MB model must not block scene rendering",
  );
  assert.notDeepEqual(await canvas.screenshot(), empty);
  // Wait for the actual browser recovery transaction, not an arbitrary autosave delay.
  let recovered = false;
  for (let attempt = 0; attempt < 100 && !recovered; attempt++) {
    recovered = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open("vthere-local-drafts", 2);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(["session"], "readonly");
            const request = tx.objectStore("session").getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(
                request.result.some((r) => {
                  const document =
                    typeof r.document === "string" ? JSON.parse(r.document) : r.document;
                  return document?.scenes?.[0]?.objects?.length === 1;
                }),
              );
            };
          };
          open.onerror = () => resolve(false);
        }),
    );
    if (!recovered) await page.waitForTimeout(100);
  }
  if (!recovered) console.error(await page.locator("body").innerText());
  assert.ok(recovered, "The actual recovery transaction must finish before reload");
  denyCrate = true;
  await page.reload();
  await page.getByRole("button", { name: "Recover changes" }).click();
  await page.getByRole("link", { name: "Sign in in another tab" }).waitFor();
  assert.equal(
    await page.locator(".object-row").count(),
    1,
    "Failed bytes must not delete document objects",
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/editor-partial-load.png" });
  denyCrate = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready();
  assert.equal(await page.locator(".object-row").count(), 1);
  await page.screenshot({ path: "test-results/editor-session-loading.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: packaged login return, demand-loaded room/crate, recovery, expired model request and retry.",
  );
} finally {
  await browser.close();
}
