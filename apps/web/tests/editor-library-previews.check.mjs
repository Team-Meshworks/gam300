import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5185/",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  const project = await serveProject(page, process.argv[2] ?? "http://127.0.0.1:5185/");
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
      return { name: asset.name, url: new URL(asset.url, location.href).href };
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
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await checkPreview(model);
  console.log("PASS: room and asset picker thumbnails are generated before placement");
} finally {
  await browser.close();
}
