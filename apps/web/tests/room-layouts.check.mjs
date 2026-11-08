import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const target = new URL("/editor.html", process.argv[2] ?? "http://127.0.0.1:5185/").href;
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  let page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(target);
  await page
    .getByRole("status")
    .filter({ hasText: "Scene ready" })
    .waitFor({ timeout: 60000 })
    .catch(async (error) => {
      console.error(errors, await page.locator("body").innerText());
      throw error;
    });
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  const layouts = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    return assets
      .filter((asset) => asset.id.startsWith("room-") && asset.kind === "environment")
      .map(({ id, name }) => ({ id, name }));
  });
  assert.equal(layouts.length, 16);
  const manifest = JSON.parse(
    await readFile(new URL("../../../assets/manifest.json", import.meta.url), "utf8"),
  );
  for (const { id } of layouts) {
    const entry = manifest.assets.find((asset) => asset.assetId === id);
    assert.deepEqual(
      await readFile(new URL("../../../assets/" + entry.file, import.meta.url)),
      await readFile(new URL("../../../assets/" + entry.sourceFile, import.meta.url)),
      `${id} delivery preserves the supplied bytes`,
    );
  }
  async function openRooms() {
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    return page.getByRole("group", { name: "Rooms options", exact: true });
  }
  async function choose(name) {
    const picker = await openRooms();
    await picker.getByRole("button", { name, exact: true }).click();
  }
  async function saved(id) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const doc = await page.evaluate(async () => {
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
        const result = await loadRecoverySession(
          new Map(assets.map((asset) => [asset.id, asset.kind])),
        );
        return result.ok ? result.value?.document : null;
      });
      if (doc?.scenes[0].environmentAssetId === id) return doc;
      await page.waitForTimeout(100);
    }
    throw Error(`Room ${id} was not saved`);
  }
  const picker = await openRooms();
  assert.equal(await picker.locator(".asset-card").count(), 17);
  const door = page.locator('.scene-toolbar [data-category="rooms"] img');
  assert.deepEqual(
    await door.evaluate((img) => ({
      width: img.getBoundingClientRect().width,
      height: img.getBoundingClientRect().height,
    })),
    { width: 35, height: 35 },
  );
  await mkdir("test-results/room-layouts", { recursive: true });
  await page.screenshot({ path: "test-results/room-layouts/picker.png", animations: "disabled" });
  await picker.getByRole("searchbox", { name: "Search rooms", exact: true }).fill("All 4");
  assert.equal(await picker.locator(".asset-card").count(), 1);
  await picker.getByRole("button", { name: "All 4 Doors", exact: true }).click();
  const first = await saved("room-doors-1-2-3-4-v1");
  assert.equal(first.scenes[0].objects.length, 0);
  assert.ok(
    first.scenes[0].startCamera.position[0] > 30,
    "Initial overview fits the full-size room",
  );
  await choose("All 4 Doors");
  await page.waitForFunction(
    () =>
      document.querySelector(".viewport-stage")?.getAttribute("data-placing-asset") ===
      "room-doors-1-2-3-4-v1",
  );
  await page.keyboard.press("Escape");
  assert.equal((await saved("room-doors-1-2-3-4-v1")).scenes[0].objects.length, 0);
  await page.close();

  // Capture the actual rendered environment roots, beyond the normalized cached model.
  const captureRoom = () =>
    page.evaluate(async () => {
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const { editorModelCache } = await import("/graphics/scene.ts");
      const lease = await editorModelCache.acquire(
        assets.find((a) => a.id === "room-space1-v1"),
        new AbortController().signal,
      );
      const prototype = Object.getPrototypeOf(Object.getPrototypeOf(lease.value.model));
      const add = prototype.add;
      prototype.add = function (...nodes) {
        if (this.isScene)
          for (const node of nodes)
            if (node.name === "placement-preview") window.roomGhost = node;
            else if (node.isGroup) window.renderedRoom = node;
        return add.apply(this, nodes);
      };
      lease.release();
    });
  for (const layout of layouts) {
    // A fresh context gives every layout its own initial environment.
    page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(target);
    await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Third person", exact: true }).click();
    await captureRoom();
    await choose(layout.name);
    const doc = await saved(layout.id);
    const loadedPicker = await openRooms();
    const thumbnail = loadedPicker
      .getByRole("button", { name: layout.name, exact: true })
      .locator("img");
    await thumbnail.waitFor();
    await page.waitForFunction((name) => {
      const button = [...document.querySelectorAll(".room-picker .asset-card-pick")].find(
        (node) => node.getAttribute("aria-label") === name,
      );
      const img = button?.querySelector("img");
      return img?.complete && img.naturalWidth > 0;
    }, layout.name);
    await page.keyboard.press("Escape");
    assert.equal(
      doc.scenes[0].objects.length,
      0,
      "Layout selection must not create a Starter room module",
    );
    const bounds = await page.evaluate(() => {
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      window.renderedRoom.updateMatrixWorld(true);
      window.renderedRoom.traverse((node) => {
        const positions = node.geometry?.attributes.position;
        if (!positions) return;
        const e = node.matrixWorld.elements;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i),
            y = positions.getY(i),
            z = positions.getZ(i);
          const point = [
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          ];
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], point[a]);
            max[a] = Math.max(max[a], point[a]);
          }
        }
      });
      return { min, max, fogFar: window.renderedRoom.parent.fog.far };
    });
    assert.ok(Math.abs(bounds.min[0] + bounds.max[0]) < 0.001, `${layout.name} is centred on X`);
    assert.ok(Math.abs(bounds.min[2] + bounds.max[2]) < 0.001, `${layout.name} is centred on Z`);
    assert.ok(Math.abs(bounds.min[1]) < 0.001, `${layout.name} rests on the grid`);
    assert.ok(bounds.max[0] - bounds.min[0] > 18, "Original metre scale is preserved");
    assert.ok(bounds.fogFar > 100, "Fog must not hide complete room layouts at overview distance");
    await page.close();
  }
  // Dragging a layout into an empty project also creates the environment.
  page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(target);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await captureRoom();
  await openRooms();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  // The picker is intentionally hidden until dragend, so retain its DOM selector.
  const choice = page.locator('.room-picker .asset-card-pick[aria-label="Door 2"]');
  await choice.dispatchEvent("dragstart", { dataTransfer: transfer });
  const stage = page.locator(".viewport-stage");
  await stage.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector(".viewport-stage")?.getAttribute("data-dragging-asset") ===
      "room-doors-2-v1",
  );
  const dragDeadline = Date.now() + 15000;
  let validDrop = false;
  while (Date.now() < dragDeadline && !validDrop) {
    await stage.dispatchEvent("dragover", { clientX: 720, clientY: 500, dataTransfer: transfer });
    validDrop = await page.evaluate(() => {
      let color;
      window.roomGhost?.traverse((node) => {
        if (node.isMesh) color = node.material.color.getHexString();
      });
      return window.roomGhost?.visible && color === "999999";
    });
    if (!validDrop) await page.waitForTimeout(100);
  }
  assert.ok(validDrop, "Dragging Door 2 produces a valid placement preview");
  await stage.dispatchEvent("drop", { clientX: 720, clientY: 500, dataTransfer: transfer });
  await choice.dispatchEvent("dragend", { dataTransfer: transfer });
  assert.equal((await saved("room-doors-2-v1")).scenes[0].objects.length, 0);
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await saved("room-doors-2-v1");
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.screenshot({
    path: "test-results/room-layouts/door-two.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  assert.equal(
    await page
      .locator(".asset-picker")
      .getByRole("button", { name: "All 4 Doors", exact: true })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowPicker = await openRooms();
  const box = await narrowPicker.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "Rooms picker fits a narrow viewport");
  await page.screenshot({
    path: "test-results/room-layouts/picker-narrow.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Room layouts passed: 16 originals, previews, search, isolated environment placement, repeat placement, drag and reload.",
  );
} finally {
  await browser.close();
}
