import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(target);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  const stage = page.locator(".viewport-stage");
  await stage.click({ position: { x: 700, y: 480 } });
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "Sample crate", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await stage.click({ position: { x: 800, y: 500 } });
  async function saved(matches = () => true) {
    const deadline = Date.now() + 15000;
    let last;
    while (Date.now() < deadline) {
      const doc = await page.evaluate(async () => {
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const { loadRecoverySession } = await import("/persistence/recovery-session.ts");
        const result = await loadRecoverySession(
          new Map(assets.map((asset) => [asset.id, asset.kind])),
        );
        return result.ok ? result.value?.document : null;
      });
      last = doc?.scenes[0];
      if (last?.objects.length === 1 && matches(last)) return last;
      await page.waitForTimeout(100);
    }
    throw new Error(
      `Expected scene transform did not reach recovery storage: ${JSON.stringify(last)}`,
    );
  }
  const before = await saved();
  const roomTransform = (scene) =>
    scene.environmentTransform ?? { position: [0, 0, 0], rotation: [0, 0, 0] };
  const tree = page.locator(".scene-tree");
  await tree.locator(".environment-row").click();
  await tree.locator(".object-row").click({ modifiers: ["Shift"] });
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 2);
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const x = page.getByRole("textbox", { name: "Sample crate transform X (m)", exact: true });
  await x.fill("10");
  await x.press("Enter");
  assert.equal(Number(await x.inputValue()), 10, "Moving room and crate together reaches x=10");
  const moved = await saved(
    (scene) => Math.abs(scene.objects[0].transform.position[0] - 10) < 0.001,
  );
  const delta = 10 - before.objects[0].transform.position[0];
  assert.ok(
    Math.abs(roomTransform(moved).position[0] - roomTransform(before).position[0] - delta) < 0.001,
    "Room moves by the same distance as the crate",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(
    Number(await x.inputValue()),
    Number(before.objects[0].transform.position[0].toFixed(2)),
    "One undo restores the crate",
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(Number(await x.inputValue()), 10, "Redo restores the group move");
  await saved(
    (scene) =>
      Math.abs(roomTransform(scene).position[0] - roomTransform(moved).position[0]) < 0.001,
  );
  const yaw = page.getByRole("textbox", { name: "Sample crate rotation Y (°)", exact: true });
  await yaw.fill("90");
  await yaw.press("Enter");
  const rotated = await saved(
    (scene) => Math.abs(scene.objects[0].transform.rotation[1] - Math.SQRT1_2) < 0.001,
  );
  assert.ok(
    Math.abs(rotated.environmentTransform.rotation[1] - Math.SQRT1_2) < 0.001,
    "Rotation carries the room with the crate",
  );
  const distance = (scene) =>
    Math.hypot(
      ...scene.objects[0].transform.position.map(
        (value, index) => value - scene.environmentTransform.position[index],
      ),
    );
  assert.ok(
    Math.abs(distance(rotated) - distance(moved)) < 0.001,
    "Rotation preserves the room-to-crate distance",
  );
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const reopened = await saved(
    (scene) => Math.abs(scene.objects[0].transform.rotation[1] - Math.SQRT1_2) < 0.001,
  );
  assert.deepEqual(
    reopened.environmentTransform,
    rotated.environmentTransform,
    "Recovery retains the room transform",
  );
  await tree.locator(".object-row").click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  await x.fill("100");
  await x.press("Enter");
  const clampedX = Number(await x.inputValue());
  assert.ok(clampedX < 100, "Stationary room still constrains the crate");
  const constrained = await saved(
    (scene) => Math.abs(scene.objects[0].transform.position[0] - clampedX) < 0.01,
  );
  assert.deepEqual(
    constrained.environmentTransform,
    reopened.environmentTransform,
    "Lone crate movement leaves the room stationary",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Moving room and exhibit: translation, rotation, undo/redo, recovery and stationary room constraint passed.",
  );
} finally {
  await browser.close();
}
