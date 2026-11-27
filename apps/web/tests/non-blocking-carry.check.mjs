import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1024 },
  });
  const page = await context.newPage();
  await page.clock.install();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = await serveProject(page, target);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  const stage = page.locator(".viewport-stage");
  await stage.click({ position: { x: 700, y: 480 } });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openSavedProject(page);
  const box = await stage.boundingBox();
  const placementPoint = await page.evaluate(
    async ({ box, doc }) => {
      const source = await (await fetch("/graphics/scene.ts")).text();
      const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
      const pose = doc.scenes[0].startCamera;
      const camera = new THREE.PerspectiveCamera(pose.fovDegrees, box.width / box.height, 0.1, 100);
      camera.position.fromArray(pose.position);
      camera.quaternion.fromArray(pose.rotation);
      camera.updateMatrixWorld();
      const point = new THREE.Vector3(0, 0, 0).project(camera);
      return { x: ((point.x + 1) / 2) * box.width, y: ((1 - point.y) / 2) * box.height };
    },
    { box, doc: project.document() },
  );
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const crateButton = page
    .locator(".asset-picker")
    .getByRole("button", { name: "Trigger Crate", exact: true });
  await crateButton.waitFor({ state: "visible" });
  await crateButton.click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await stage.click({ position: placementPoint });
  const saved = await project.waitForDocument((document) =>
    document.scenes[0]?.objects.some((object) => object.assetId === "trigger-crate-v1"),
  );
  const crate = saved.scenes[0].objects.find((object) => object.assetId === "trigger-crate-v1");
  assert.ok(crate, "Trigger crate is placed");
  await page.locator(`[data-object-id="${crate.id}"]`).click();
  await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
  await project.waitForDocument((document) =>
    document.scenes[0]?.hotspots?.some((hotspot) => hotspot.objectId === crate.id),
  );
  await page.locator(`[data-object-id="${crate.id}"]`).click();

  const viewToggle = page.getByRole("button", { name: "Third person", exact: true });
  if ((await viewToggle.getAttribute("aria-pressed")) === "true") await viewToggle.click();
  await stage.click({ position: { x: box.width / 2, y: box.height / 2 } });
  assert.equal(await page.evaluate(() => document.pointerLockElement?.tagName ?? null), "CANVAS");
  const walk = async (milliseconds) => {
    await page.keyboard.down("s");
    await page.clock.runFor(milliseconds);
    await page.keyboard.up("s");
  };
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  try {
    await walk(600);
    await page.mouse.down();
    await page.clock.runFor(100);
    await page.mouse.up();
  } finally {
    await page.clock.resume();
  }
  assert.equal(
    await page.locator(`[data-object-id="${crate.id}"]`).getAttribute("aria-pressed"),
    "true",
    "Crosshair picks the hotspot owner",
  );
  await page.mouse.down();
  await walk(300);
  await page.mouse.up();
  const carried = await project
    .waitForDocument((document) => {
      const next = document.scenes[0]?.objects.find((object) => object.id === crate.id);
      return (
        next &&
        next.transform.position.some(
          (value, axis) => Math.abs(value - crate.transform.position[axis]) > 0.01,
        )
      );
    })
    .catch(() => null);
  assert.ok(carried, "Hotspot owner is carryable in first person");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
