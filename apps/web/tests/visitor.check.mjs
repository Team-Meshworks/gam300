import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const publicationId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const snapshot = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
snapshot.title = "Visitor test exhibition";
snapshot.projectId = snapshot.projectId.toUpperCase();
snapshot.scenes[0].environmentAssetId = assetId;
snapshot.scenes[0].objects = [];
delete snapshot.scenes[0].hotspots;
delete snapshot.scenes[0].interactions;
snapshot.scenes[0].startCamera = { position: [0, 0, 5], rotation: [0, 0, 0, 1], fovDegrees: 40 };
snapshot.scenes.push({
  ...structuredClone(snapshot.scenes[0]),
  id: "33333333-3333-4333-8333-333333333333",
  name: "Second scene",
});
const positions = Buffer.alloc(36);
[-1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
const gltf = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: positions.length }],
  bufferViews: [{ buffer: 0, byteLength: positions.length }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [-1, -1, 0],
      max: [1, 1, 0],
    },
  ],
};
const json = Buffer.from(JSON.stringify(gltf));
const padded = (json.length + 3) & ~3;
const glb = Buffer.alloc(20 + padded + 8 + positions.length, 0x20);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(padded, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
json.copy(glb, 20);
glb.writeUInt32LE(positions.length, 20 + padded);
glb.writeUInt32LE(0x004e4942, 24 + padded);
positions.copy(glb, 28 + padded);
const hash = createHash("sha256").update(glb).digest("hex");
let mode = "allowed";
const requests = [];
const errors = [];
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(5000);
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.route("**/api/publications/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (mode === "denied") return route.fulfill({ status: 404 });
    if (path.endsWith("/manifest"))
      return route.fulfill({
        json: {
          publicationId,
          projectId: snapshot.projectId.toLowerCase(),
          sourceRevision: 4,
          assets: [
            {
              id: assetId,
              kind: "environment",
              sha256: mode === "bad-hash" ? "0".repeat(64) : hash,
              url: `/api/publications/${publicationId}/assets/${assetId}/bytes`,
            },
          ],
        },
      });
    if (path.endsWith("/bytes"))
      return route.fulfill({ contentType: "model/gltf-binary", body: glb });
    return route.fulfill({ json: snapshot });
  });
  await page.goto(`${origin}/p/${publicationId}`);
  await page.getByRole("heading", { name: "Visitor test exhibition" }).waitFor();
  await page.getByRole("status").getByText("Exhibition ready").waitFor();
  const canvas = page.locator("canvas[aria-label='Exhibition view']");
  assert.equal(await canvas.count(), 1);
  assert.ok(await canvas.evaluate((element) => element.width > 0 && element.height > 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const original = await canvas.screenshot();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await canvas.evaluate((element) => element === document.activeElement), true);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.notDeepEqual(await canvas.screenshot(), original, "Arrow key moves the visible camera");
  await page.getByRole("button", { name: "Reset view" }).click();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.deepEqual(await canvas.screenshot(), original, "Reset restores the starting view");
  const first = await canvas.elementHandle();
  await page.getByRole("combobox").selectOption("1");
  await page.getByRole("status").getByText("Exhibition ready").waitFor();
  assert.equal(await first.evaluate((element) => element.isConnected), false);
  assert.equal(await canvas.count(), 1);
  assert.equal(
    requests.some((path) => /^\/editor\//.test(path)),
    false,
  );
  mode = "bad-hash";
  await page.reload();
  await page.getByText("An exhibition asset could not be verified.").waitFor();
  mode = "denied";
  await page.reload();
  await page.getByRole("heading", { name: "Exhibition unavailable" }).waitFor();
  const signIn = page.getByRole("link", { name: "Sign in to view exhibition" });
  assert.equal(
    await signIn.getAttribute("href"),
    `/login?returnTo=${encodeURIComponent(`/p/${publicationId}`)}`,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Visitor browser checks passed: canvas, keyboard, scene replacement, mobile, hash rejection and sign-in return.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
