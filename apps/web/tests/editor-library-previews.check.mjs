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
  await page.route("**/graphics/library-previews.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function generateLibraryPreviews(assets, onPreview) {
      window.previewAssets = assets.map(({id, kind, name, thumbnail}) => ({id, kind, name, thumbnail}));
      for (const asset of assets) if (!asset.thumbnail && ["model", "environment"].includes(asset.kind)) onPreview(asset.id, "data:image/png;base64,dGVzdA==");
      return () => { window.previewsCancelled = true; };
    }`,
    }),
  );
  await page.goto(project.url);
  assert.equal(
    await page.evaluate(() => window.previewAssets),
    undefined,
    "A closed picker must not generate previews",
  );
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.locator('.room-picker img[src^="data:image/png"]').first().waitFor({ timeout: 10000 });
  const candidates = await page.evaluate(() => window.previewAssets);
  assert.ok(candidates.some((asset) => asset.kind === "environment" && !asset.thumbnail));
  assert.ok(candidates.every((asset) => asset.kind === "environment"));
  await page.getByRole("button", { name: "Close rooms" }).click();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page.waitForFunction(() => window.previewAssets?.some((asset) => asset.kind === "model"));
  const model = await page.evaluate(() =>
    window.previewAssets.find((asset) => asset.kind === "model" && !asset.thumbnail),
  );
  assert.ok(model);
  await page
    .getByRole("button", { name: model.name, exact: true })
    .locator('img[src^="data:image/png"]')
    .waitFor({ timeout: 10000 });
  console.log("PASS: room and asset picker thumbnails are generated before placement");
} finally {
  await browser.close();
}
