import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import * as THREE from "three";

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const room = page.getByRole("button", { name: "Add test-room", exact: true });
  const rows = page.locator(".object-row");
  await room.click();
  assert.equal(await rows.count(), 1);
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const firstX = page.getByRole("textbox", { name: "Room 1 transform X (m)", exact: true });
  assert.equal(await firstX.isEnabled(), true);
  await firstX.fill("3");
  await firstX.press("Enter");
  assert.equal(await firstX.inputValue(), "3");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await firstX.inputValue(), "0");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const stage = page.locator(".viewport-stage");
  const box = await stage.boundingBox();
  assert.ok(box);
  const camera = new THREE.PerspectiveCamera(40, box.width / box.height, 0.1, 100);
  camera.position.set(12, 16, 18);
  camera.quaternion.set(
    -0.29962059992658957,
    0.2752183320355054,
    0.09071781822041597,
    0.9089844021041025,
  );
  camera.updateMatrixWorld(true);
  const point = (x, z) => {
    const projected = new THREE.Vector3(x, 0, z).project(camera);
    return {
      clientX: box.x + ((projected.x + 1) * box.width) / 2,
      clientY: box.y + ((1 - projected.y) * box.height) / 2,
    };
  };
  async function dragRoom(x, z, cue) {
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await room.dispatchEvent("dragstart", { dataTransfer });
    await stage.dispatchEvent("dragover", { dataTransfer, ...point(x, z) });
    assert.equal(await page.locator(".drop-cue").textContent(), cue);
    if (process.env.ROOM_SCREENSHOT && cue === "Snapped to room edge")
      await page.screenshot({ path: process.env.ROOM_SCREENSHOT });
    await stage.dispatchEvent("drop", { dataTransfer, ...point(x, z) });
    await room.dispatchEvent("dragend", { dataTransfer });
    await dataTransfer.dispose();
  }
  await dragRoom(9.5, 0.2, "Snapped to room edge");
  assert.equal(await rows.count(), 2);
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const x = page.getByRole("textbox", { name: "Room 2 transform X (m)", exact: true });
  assert.equal(await x.inputValue(), "10");
  assert.equal(
    await page.getByRole("textbox", { name: "Room 2 transform Y (m)", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Room 2 rotation X (°)", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Room 2 scale X (×)", exact: true }).isDisabled(),
    true,
  );
  await x.fill("0");
  await x.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Rooms cannot overlap" }).waitFor();
  assert.equal(await x.inputValue(), "10");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await dragRoom(0, 0, "Rooms cannot overlap");
  assert.equal(await rows.count(), 2);
  await dragRoom(-17.8, 0.2, "Snapped to grid · floor Y = 0");
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3, null, {
    timeout: 5000,
  });
  assert.equal(await rows.count(), 3);
  const secondId = await rows.last().getAttribute("data-object-id");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await rows.count(), 2);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await rows.last().getAttribute("data-object-id"), secondId);
  await room.click();
  assert.equal(await rows.count(), 4);
  const ids = await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId));
  let backedUp = false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    backedUp = await page.evaluate(async () => {
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const recovery = await loadRecoverySession(
        new Map(assets.map((asset) => [asset.id, asset.kind])),
      );
      return recovery.ok && recovery.value?.document?.scenes[0]?.objects.length === 4;
    });
    if (backedUp) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(backedUp, true, "All rooms must be backed up before reloading");
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.deepEqual(
    await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)),
    ids,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await rows.count(), 3);
  const legacy = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  await page
    .locator("#project-import")
    .setInputFiles({
      name: "legacy.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(legacy)),
    });
  await page.getByRole("dialog").getByRole("button", { name: "Don’t Save", exact: true }).click();
  await page.getByText("Project opened", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Make room movable", exact: true }).click();
  assert.equal(await page.locator(".environment-row").count(), 0);
  assert.equal(await rows.count(), legacy.scenes[0].objects.length + 1);
  assert.equal(await rows.first().getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".environment-row").count(), 1);
  assert.equal(await rows.count(), legacy.scenes[0].objects.length);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: repeated rooms, edge/grid preview and drop, overlap rejection, floor constraints, undo/redo and reload recovery",
  );
} finally {
  await browser.close();
}
