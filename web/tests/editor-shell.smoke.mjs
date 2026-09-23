import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("dialog", (dialog) => {
    dialog.accept().catch((error) => pageErrors.push(error.message));
  });

  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  const ready = page.getByRole("status").filter({ hasText: "Scene ready" });
  const asset = page.getByRole("button", { name: "Add test-crate", exact: true });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const rows = page.locator(".object-row");
  const stage = page.locator(".viewport-stage");
  await ready.waitFor();
  assert.equal(await page.title(), "VThere Spatial Experience Editor");
  assert.equal(
    await page.getByRole("heading", { name: "VThere Spatial Experience Editor" }).count(),
    1,
  );
  assert.equal(await asset.isEnabled(), true);
  assert.equal(await rows.count(), 0);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.ok(
    await asset.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  assert.equal(await page.getByText("Start with a sample model.", { exact: true }).count(), 0);

  await page.keyboard.press("Tab");
  assert.equal(
    await page.getByRole("link", { name: "Skip to scene" }).evaluate((link) => {
      return link === document.activeElement && link.getBoundingClientRect().top >= 0;
    }),
    true,
  );
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator("#viewport").evaluate((view) => view === document.activeElement),
    true,
  );
  await asset.focus();
  await page.keyboard.press("Enter");
  assert.equal(await rows.count(), 1);
  const firstId = await rows.first().getAttribute("data-object-id");
  const stageBox = await stage.boundingBox();
  assert.ok(stageBox);
  await asset.dragTo(stage, {
    targetPosition: { x: stageBox.width * 0.7, y: stageBox.height * 0.62 },
  });
  assert.equal(await rows.count(), 2, "One completed drop creates one object");
  const secondId = await rows.nth(1).getAttribute("data-object-id");
  assert.notEqual(firstId, secondId);
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");

  await stage.click({ position: { x: stageBox.width / 2, y: stageBox.height / 2 - 10 } });
  assert.equal(
    await rows.first().getAttribute("aria-pressed"),
    "true",
    "Viewport and list share selection",
  );
  await rows.nth(1).click();
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");
  if (process.env.SMOKE_SCREENSHOT) {
    await page.screenshot({ path: process.env.SMOKE_SCREENSHOT, fullPage: true });
  }

  await asset.dragTo(page.getByRole("heading", { name: "Asset library", exact: true }));
  assert.equal(await rows.count(), 2, "Dropping outside the scene leaves objects unchanged");
  const tileBox = await asset.boundingBox();
  assert.ok(tileBox);
  await page.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2, {
    steps: 8,
  });
  await page.getByText("Drop to place", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await rows.count(), 2, "Escape cancels placement");
  await page.getByText("Drop to place", { exact: true }).waitFor({ state: "hidden" });
  const externalPayload = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData("application/x-vthere-asset", "unrecognized-asset");
    return transfer;
  });
  await stage.dispatchEvent("drop", { dataTransfer: externalPayload });
  assert.equal(await rows.count(), 2, "External or unknown asset payloads cannot add objects");
  await externalPayload.dispose();

  await undo.click();
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.first().getAttribute("data-object-id"), firstId);
  await redo.click();
  assert.equal(
    await rows.nth(1).getAttribute("data-object-id"),
    secondId,
    "Redo preserves identity and order",
  );
  await undo.click();
  await asset.click();
  assert.equal(await rows.count(), 2);
  assert.notEqual(await rows.nth(1).getAttribute("data-object-id"), secondId);
  assert.equal(await redo.isDisabled(), true, "A new addition clears the redo branch");

  for (const width of [1366, 1024, 760, 320]) {
    await page.setViewportSize({ width, height: 768 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      const host = document.querySelector(".viewport-stage");
      return (
        canvas &&
        host &&
        Math.abs(canvas.clientWidth - host.clientWidth) <= 1 &&
        Math.abs(canvas.clientHeight - host.clientHeight) <= 1 &&
        Math.abs(canvas.width - host.clientWidth * Math.min(devicePixelRatio, 2)) <= 1
      );
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `No overflow at ${width}px`,
    );
    assert.equal(await page.locator("canvas").count(), 1);
    assert.equal(await rows.count(), 2);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".asset-art")
      .first()
      .evaluate((art) => getComputedStyle(art).transitionDuration),
    "0s",
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  assert.deepEqual(consoleErrors, [], "No console errors during normal authoring");

  await page.getByRole("button", { name: "Add test-room", exact: true }).click();
  assert.equal(await rows.count(), 3, "Room and crates coexist");
  const roomId = await rows.last().getAttribute("data-object-id");
  await undo.click();
  assert.equal(await rows.count(), 2);
  await redo.click();
  assert.equal(await rows.last().getAttribute("data-object-id"), roomId);

  // The saved fixture should replace placement history and show its two authored objects
  await page.getByRole("button", { name: "Open sample project", exact: true }).click();
  assert.deepEqual(await rows.allTextContents(), ["First crate", "Second crate"]);
  assert.deepEqual(await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)), [
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Add test-room", exact: true }).count(), 0);
  await asset.click();
  assert.equal(await rows.count(), 3);
  await undo.click();
  assert.equal(await rows.count(), 2);
  await redo.click();
  assert.equal(await rows.count(), 3);
  await page.getByRole("button", { name: "Open sample project", exact: true }).click();
  assert.equal(await rows.count(), 2);
  assert.equal(await page.locator("canvas").count(), 1);
  if (process.env.SCENE_SCREENSHOT) {
    await page.screenshot({ path: process.env.SCENE_SCREENSHOT });
  }

  const samplePath = "**/*test-crate*.glb*";
  await page.route(samplePath, (route) => {
    // Vite also serves a JavaScript URL module for each model
    // Fail the model download after the application itself has loaded
    return route.request().resourceType() === "fetch"
      ? route.fulfill({ status: 503, body: "Unavailable" })
      : route.continue();
  });
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Couldn't load the asset library" }).waitFor();
  assert.equal(await asset.isDisabled(), true);
  await page.unroute(samplePath);
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.focus();
  await page.keyboard.press("Enter");
  await ready.waitFor();
  assert.equal(await page.locator("canvas").count(), 1, "Retry replaces the old canvas");
  assert.equal(await asset.isEnabled(), true);
  assert.equal(await retry.count(), 0);

  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === "webgl2" ? null : original.call(this, type, ...args);
    };
  });
  await page.reload();
  const unsupported = page.getByRole("status").filter({ hasText: "The 3D view needs WebGL 2" });
  await unsupported.waitFor();
  await retry.click();
  await unsupported.waitFor();
  assert.equal(await page.locator("canvas").count(), 0);
  assert.equal(await asset.isDisabled(), true);
  assert.deepEqual(pageErrors, [], "No uncaught page errors in any flow");
  console.log(
    "PASS: asset placement, sample project loading, undo/redo, selection, keyboard, resizing, retry and WebGL fallback",
  );
} finally {
  await browser.close();
}
