import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { launchPersistentBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";
import { waitForStoredDraft } from "./stored-draft.mjs";

// Run against a built preview. Real bundled GLBs are delivered by HTTP; only the account
// API is simulated here. Actual Identity/database coverage lives in the HTTPS server suite.
const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5194/").origin;
const userId = "11111111-1111-4111-8111-111111111111";
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
                userId,
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
  const projectId = new URL(project.url).searchParams.get("projectId");
  const objectId = await page.locator(".object-row[data-object-id]").getAttribute("data-object-id");
  await waitForStoredDraft(page, () =>
    page.evaluate(
      async ({ userId, projectId, objectId }) => {
        const database = "vthere-local-drafts";
        if (!(await indexedDB.databases()).some(({ name }) => name === database)) return false;
        const stored = await new Promise((resolve, reject) => {
          const open = indexedDB.open(database, 2);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("session")) {
              db.close();
              resolve(undefined);
              return;
            }
            const tx = db.transaction(["session"], "readonly");
            const request = tx.objectStore("session").get(["account", userId, projectId]);
            tx.oncomplete = () => {
              db.close();
              resolve(request.result?.document);
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
          open.onerror = () => reject(open.error);
          open.onblocked = () => reject(new Error("Recovery storage is blocked"));
        });
        const objects = JSON.parse(stored ?? "null")?.scenes?.[0]?.objects;
        return objects?.length === 1 && objects[0].id === objectId;
      },
      { userId, projectId, objectId },
    ),
  ).catch(async (cause) => {
    throw new Error(
      "The placed object was not recovered from storage: " +
        (await page.locator("body").innerText()),
      { cause },
    );
  });
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
