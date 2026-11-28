import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5185/",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  const project = await serveProject(page, process.argv[2] ?? "http://127.0.0.1:5185/");
  const crateBytes = readFileSync(
    new URL("../../../assets/delivery/test-crate.glb", import.meta.url),
  );
  const crateId = "11111111-1111-4111-8111-111111111111";
  const crate = {
    id: crateId,
    name: "Uploaded crate",
    kind: "model",
    url: `/api/v1/assets/${crateId}/bytes`,
    sha256: createHash("sha256").update(crateBytes).digest("hex"),
    thumbnail: null,
    category: null,
  };
  await page.context().route("**/api/v1/assets", (route) => route.fulfill({ json: [crate] }));
  const crateUrl = new URL(crate.url, project.url).href;
  let crateRequests = 0;
  await page.context().route(crateUrl, (route) => {
    // Only the worker's model load fails. The same bytes are available on retry.
    if (++crateRequests === 1) return route.fulfill({ status: 503 });
    return route.fulfill({ body: crateBytes, contentType: "model/gltf-binary" });
  });
  const fetched = new Set();
  page.on("request", (request) => {
    if (request.resourceType() === "fetch") fetched.add(request.url());
  });
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const [room, model] = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    return ["room-space1-v1", "sample-snowglobe-v1"].map((id) => {
      const asset = assets.find((entry) => entry.id === id);
      if (!asset || asset.thumbnail) throw new Error(`Expected a generated preview for ${id}`);
      return { id, name: asset.name, url: new URL(asset.url, location.href).href };
    });
  });
  async function checkPreview(asset) {
    const image = page
      .getByRole("button", { name: asset.name, exact: true })
      .locator('img[src^="data:image/png"]');
    await image.waitFor();
    const visiblePixels = await image.evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const context = canvas.getContext("2d");
      context.drawImage(img, 0, 0, 32, 32);
      return context.getImageData(0, 0, 32, 32).data.some((value, i) => i % 4 === 3 && value > 0);
    });
    assert.ok(visiblePixels, `Expected visible geometry in the ${asset.name} thumbnail`);
    assert.ok(fetched.has(asset.url), `Expected the picker to load ${asset.name}`);
  }
  assert.ok(
    !fetched.has(room.url) && !fetched.has(model.url),
    "Closed pickers leave model bytes unloaded",
  );
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await checkPreview(room);
  assert.equal(fetched.has(model.url), false, "Opening rooms leaves library-only models unloaded");
  await page.getByRole("button", { name: "Close rooms" }).click();
  await page.evaluate(async () => {
    const { editorModelCache } = await import("/graphics/editor-model-cache.ts");
    const acquire = editorModelCache.acquire.bind(editorModelCache);
    window.mainPreviewLoads = [];
    editorModelCache.acquire = (asset, ...args) => {
      window.mainPreviewLoads.push(asset.id);
      return acquire(asset, ...args);
    };
    window.previewWorkerResults = [];
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          window.previewWorkerResults.push(data.type === "preview" ? data.id : data.type);
        });
      }
    };
  });
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await checkPreview(model);
  await page.waitForFunction(() => window.previewWorkerResults.includes("done"));
  const results = await page.evaluate(() => window.previewWorkerResults);
  assert.deepEqual(
    results.filter((result) => [model.id, crate.id, "done", "unavailable"].includes(result)),
    [model.id, "done"],
    "The worker previews the healthy model, skips the crate and finishes normally",
  );
  await checkPreview({ name: crate.name, url: crateUrl });
  assert.deepEqual(
    await page.evaluate(() => window.mainPreviewLoads),
    [crate.id],
    "Only the model skipped by the worker is acquired on the main thread",
  );
  assert.equal(crateRequests, 2, "The skipped crate loads on its first retry");
  console.log(
    "PASS: room and asset picker thumbnails render before placement, including a model skipped by the worker",
  );
} finally {
  await browser.close();
}
