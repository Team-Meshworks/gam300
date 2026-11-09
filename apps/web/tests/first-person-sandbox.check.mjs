import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.route("**/sandbox-review-parent.html", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: '<iframe title="Sandbox" sandbox="allow-scripts allow-same-origin" src="/sandbox-review-child.html" style="width:800px;height:600px;border:0"></iframe>',
  }),
);
await page.route("**/sandbox-review-child.html", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><body style="margin:0"><div id="host" style="width:800px;height:600px"></div></body>',
  }),
);
try {
  await page.goto(`${origin}/sandbox-review-parent.html`);
  const frame = page.frameLocator('iframe[title="Sandbox"]');
  await frame.locator("#host").waitFor();
  const child = page.frames().find((item) => item.url().endsWith("/sandbox-review-child.html"));
  await child.evaluate(async (fixture) => {
    const { initScene } = await import("/graphics/scene.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const object = {
      ...fixture.scenes[0].objects[0],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    };
    const { promise: ready, resolve } = Promise.withResolvers();
    let selected = null,
      handle;
    handle = initScene(
      document.getElementById("host"),
      assets.filter((asset) => asset.id === "test-crate-v1"),
      {
        onStatus(status) {
          if (status === "ready") resolve();
        },
        onThumbnail() {},
        onObjectClick() {},
        onUpdate() {},
        onSelect(id) {
          selected = id;
          handle.update([object], id);
        },
        onTransform() {},
      },
    );
    await ready;
    await handle.prepareAsset(object.assetId);
    handle.modeManager.initializeView("first");
    handle.setEditingEnabled(true);
    handle.update([object], null);
    handle.showCamera({ position: [0, 0.5, 6], rotation: [0, 0, 0, 1], fovDegrees: 40 });
    window.review = {
      get selected() {
        return selected;
      },
      object,
      handle,
    };
  }, fixture);
  const canvas = frame.locator("canvas");
  await canvas.click({ position: { x: 400, y: 300 } });
  await page.waitForTimeout(250);
  assert.equal(
    await child.evaluate(() => document.pointerLockElement),
    null,
    "Sandbox denies pointer lock",
  );
  await canvas.click({ position: { x: 400, y: 300 } });
  assert.equal(
    await child.evaluate(() => window.review.selected),
    await child.evaluate(() => window.review.object.id),
    "Ordinary click selects after permanent pointer-lock denial",
  );
  const before = await child.evaluate(() =>
    window.review.handle.modeManager.camera.quaternion.toArray(),
  );
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 70, box.y + 70);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 70, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.notDeepEqual(
    await child.evaluate(() => window.review.handle.modeManager.camera.quaternion.toArray()),
    before,
    "Drag fallback still turns the camera",
  );
  console.log("PASS sandbox pointer-lock denial permits picking");
} finally {
  await browser.close();
}
