import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

function armPointerEvent(target, type) {
  return target.evaluate((type) => {
    window.nextPointerEvent = new Promise((resolve) => {
      const signal = AbortSignal.timeout(5000);
      document.addEventListener(type, () => resolve(true), { once: true, signal });
      signal.addEventListener("abort", () => resolve(false), { once: true });
    });
  }, type);
}

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
  await armPointerEvent(child, "pointerlockerror");
  await canvas.click({ position: { x: 400, y: 300 } });
  assert.equal(await child.evaluate(() => window.nextPointerEvent), true, "Sandbox denial event");
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
  await child.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.notDeepEqual(
    await child.evaluate(() => window.review.handle.modeManager.camera.quaternion.toArray()),
    before,
    "Drag fallback still turns the camera",
  );
  console.log("PASS sandbox pointer-lock denial permits picking");

  await page.goto(`${origin}/sandbox-review-child.html`);
  await page.evaluate(async () => {
    const { FpsControls } = await import("/controls/fpsControls.ts");
    const { PerspectiveCamera } = await import("/@id/three");
    const canvas = document.createElement("canvas");
    document.querySelector("#host").append(canvas);
    const controls = new FpsControls(new PerspectiveCamera(), canvas);
    controls.engage();
    window.review = { canvas, controls };
  });
  const surface = page.locator("canvas");
  await armPointerEvent(page, "pointerlockchange");
  await surface.click();
  assert.equal(await page.evaluate(() => window.nextPointerEvent), true, "Pointer lock acquired");
  assert.equal(await page.evaluate(() => window.review.controls.isCaptured()), true);
  await armPointerEvent(page, "pointerlockchange");
  await page.evaluate(() => document.exitPointerLock());
  assert.equal(await page.evaluate(() => window.nextPointerEvent), true, "Pointer lock released");
  assert.equal(await page.evaluate(() => window.review.controls.isCaptured()), false);
  assert.equal(
    await page.evaluate(() => {
      const { canvas, controls } = window.review;
      canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      document.dispatchEvent(new Event("pointerlockerror"));
      return controls.canCapture();
    }),
    true,
    "A lock error after release still allows the visitor to retry",
  );
  await armPointerEvent(page, "pointerlockchange");
  if (!(await page.evaluate(() => window.review.controls.isCaptured()))) {
    await surface.click();
    assert.equal(
      await page.evaluate(() => window.nextPointerEvent),
      true,
      "Pointer lock reacquired",
    );
  }
  assert.equal(await page.evaluate(() => window.review.controls.isCaptured()), true);
  await page.evaluate(() => window.review.controls.dispose());
  console.log("PASS pointer-lock release keeps retry available");
} finally {
  await browser.close();
}
