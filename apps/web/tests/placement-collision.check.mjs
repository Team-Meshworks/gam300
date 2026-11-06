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
  await page.getByRole("button", { name: "Display cases", exact: true }).click();
  await page.getByRole("button", { name: "Full glass display case", exact: true }).click();
  await stage.click({ position: { x: 700, y: 480 } });
  await page.locator(".object-row").last().click();
  await page.getByRole("button", { name: "Display asset library", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Place an object on this display" });
  await dialog.getByRole("button", { name: "Sample crate", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog
    .getByText("This object does not fit the display. Choose a smaller object.")
    .waitFor();
  assert.equal(await page.locator(".object-row").count(), 1, "Oversize object is not added");
  await dialog.getByRole("button", { name: "Close display editor", exact: true }).click();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "Sample crate", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await stage.click({ position: { x: 800, y: 500 } });
  await page.waitForTimeout(1000);
  await page.locator(".object-row").last().click();
  const positionPanel = () => page.getByRole("button", { name: "Position", exact: true }).click();
  const tree = () => page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const field = (axis, kind = "transform", unit = "m") =>
    page.getByRole("textbox", {
      name: `Sample crate ${kind} ${axis} (${unit})`,
      exact: true,
    });
  const values = () =>
    Promise.all(["X", "Y", "Z"].map(async (axis) => Number(await field(axis).inputValue())));
  const set = async (axis, value, kind = "transform", unit = "m") => {
    await field(axis, kind, unit).fill(String(value));
    await field(axis, kind, unit).press("Enter");
  };
  await positionPanel();
  for (const axis of ["X", "Y", "Z"]) await set(axis, 0.3, "scale", "×");
  const initial = await values();
  await set("X", 100);
  assert.equal((await values())[0], 4.65, "Room wall bounds the object");
  assert.match(
    await page.locator('output[aria-label="Selected position"]').textContent(),
    /X 4\.65/,
    "Bounded transform is committed",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await values(), initial);
  await tree();
  await page.mouse.move(850, 520);
  await page.mouse.down();
  await page.mouse.move(810, 504, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await positionPanel();
  assert.deepEqual(await values(), initial, "Escape restores drag");
  await tree();
  await page.mouse.move(850, 520);
  await page.mouse.down();
  await page.mouse.move(750, 480, { steps: 12 });
  await page.mouse.up();
  await positionPanel();
  const beforeCase = await values();
  assert.notDeepEqual(beforeCase, initial);
  await tree();
  await page.mouse.move(641, 515);
  await page.mouse.down();
  await page.mouse.move(620, 532, { steps: 8 });
  await page.mouse.up();
  await positionPanel();
  const seated = await values();
  assert.deepEqual(seated, [-0.92, 0.2, -0.66], "Release seats crate on glass-case base");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await values(), beforeCase, "One undo restores the drag start");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.deepEqual(await values(), seated);
  let saved;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    saved = await page.evaluate(async () => {
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      return loadRecoverySession(new Map(assets.map((asset) => [asset.id, asset.kind])));
    });
    const crate =
      saved.ok &&
      saved.value?.document?.scenes[0]?.objects.find(
        (object) => object.assetId === "test-crate-v1",
      );
    if (
      crate &&
      Math.abs(crate.transform.position[0] + 0.9175) < 0.01 &&
      Math.abs(crate.transform.position[1] - 0.2) < 0.01 &&
      crate.parentId
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const savedObjects = saved?.ok && saved.value?.document?.scenes[0]?.objects;
  const savedCase = savedObjects?.find((object) => object.assetId === "display-full-glass-case-v1");
  const savedCrate = savedObjects?.find((object) => object.assetId === "test-crate-v1");
  assert.ok(savedCase && savedCrate, "Seated object is backed up");
  assert.equal(savedCrate.parentId, savedCase.id, "Recovery attaches the crate to its case");
  assert.ok(
    Math.abs(savedCrate.transform.position[1] - 0.2) < 0.01,
    "Recovery retains case base height",
  );
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator(".object-row").last().click();
  await positionPanel();
  assert.deepEqual(await values(), seated, "Recovery retains the seated transform");
  await tree();
  await page.locator(".object-row").first().click();
  await positionPanel();
  const supportX = page.getByRole("textbox", {
    name: "Full glass display case transform X (m)",
    exact: true,
  });
  await supportX.fill("0.08");
  await supportX.press("Enter");
  await tree();
  await page.locator(".object-row").last().click();
  await positionPanel();
  assert.deepEqual(await values(), [0.08, 0.2, -0.66], "Moving the case carries its seated object");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await values(), seated, "Undo restores the support and object");
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log(
    "Physical placement: room boundary, oversize rejection, cancellation, case drag, recovery, support movement and undo/redo passed.",
  );
} finally {
  await browser.close();
}
