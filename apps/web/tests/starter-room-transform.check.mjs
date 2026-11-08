import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const target = new URL("/editor.html", process.argv[2] ?? "http://127.0.0.1:5173/").href;
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
  await page.locator(".viewport-stage").click({ position: { x: 700, y: 480 } });
  const room = page.locator(".scene-tree .environment-row");
  await room.click();
  const name = (await room.textContent()).trim();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const x = page.getByRole("textbox", { name: `${name} transform X (m)`, exact: true });
  const yaw = page.getByRole("textbox", { name: `${name} rotation Y (°)`, exact: true });
  async function saved(matches) {
    const deadline = Date.now() + 15000;
    let scene;
    while (Date.now() < deadline) {
      scene = await page.evaluate(async () => {
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
        const result = await loadRecoverySession(
          new Map(assets.map((asset) => [asset.id, asset.kind])),
        );
        return result.ok ? result.value?.document.scenes[0] : null;
      });
      if (scene && matches(scene)) return scene;
      await page.waitForTimeout(100);
    }
    throw new Error(
      `Expected Starter room transform in recovery storage: ${JSON.stringify(scene)}`,
    );
  }
  await x.fill("3");
  await x.press("Enter");
  assert.equal(Number(await x.inputValue()), 3, "The initial Starter room moves to x=3");
  const moved = await saved((scene) => scene.environmentTransform?.position[0] === 3);
  assert.equal(moved.objects.length, 0, "The initial room is tested without extra modules");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(Number(await x.inputValue()), 0, "Undo restores the initial room position");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(Number(await x.inputValue()), 3, "Redo restores the room position");
  await yaw.fill("90");
  await yaw.press("Enter");
  assert.equal(Number(await yaw.inputValue()), 90, "The initial room rotates to 90 degrees");
  const rotated = await saved(
    (scene) => Math.abs(scene.environmentTransform?.rotation[1] - Math.SQRT1_2) < 0.001,
  );
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const recovered = await saved(
    (scene) => Math.abs(scene.environmentTransform?.rotation[1] - Math.SQRT1_2) < 0.001,
  );
  assert.deepEqual(
    recovered.environmentTransform,
    rotated.environmentTransform,
    "Recovery retains the room transform",
  );
  await room.click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  assert.equal(Number(await x.inputValue()), 3, "Recovered room displays its position");
  assert.equal(Number(await yaw.inputValue()), 90, "Recovered room displays its rotation");
  assert.deepEqual(errors, []);
  console.log("Fresh Starter room position, rotation, undo/redo and recovery passed.");
} finally {
  await browser.close();
}
