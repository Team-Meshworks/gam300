import assert from "node:assert/strict";
import * as THREE from "three";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

function projectPoint(position, pose, box) {
  const camera = new THREE.PerspectiveCamera(pose.fovDegrees, box.width / box.height, 0.1, 100);
  camera.position.fromArray(pose.position);
  camera.quaternion.fromArray(pose.rotation);
  camera.updateMatrixWorld();
  const point = position.clone().project(camera);
  return { x: ((point.x + 1) / 2) * box.width, y: ((1 - point.y) / 2) * box.height };
}

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1024 },
  });
  const page = await context.newPage();
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
  await page
    .getByRole("status")
    .filter({ hasText: "Scene ready" })
    .waitFor({ state: "attached" })
    .catch(async (error) => {
      throw new Error(`${error.message}\n${await page.locator("body").innerText()}`);
    });
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const crateButton = page
    .locator(".asset-picker")
    .getByRole("button", { name: "Trigger Crate", exact: true });
  await crateButton.waitFor({ state: "visible" });
  await page
    .waitForFunction(
      () => {
        const button = document.querySelector('.asset-card-pick[aria-label="Trigger Crate"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      },
      undefined,
      { timeout: 60_000 },
    )
    .catch(async (error) => {
      throw new Error(`${error.message}\n${await page.locator("body").innerText()}`);
    });
  await crateButton.click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await stage.click({ position: { x: 700, y: 480 } });
  await page.locator(".object-row").filter({ hasText: "Trigger Crate" }).waitFor();
  assert.equal(
    await page.locator(".action-error").count(),
    0,
    "Non-blocking asset places without a room error",
  );
  const saved = await project.waitForDocument((document) =>
    document.scenes[0]?.objects.some((object) => object.assetId === "trigger-crate-v1"),
  );
  const crateObject = saved.scenes[0].objects.find(
    (object) => object.assetId === "trigger-crate-v1",
  );
  assert.ok(crateObject, "Placed trigger crate is backed up");
  const rect = await page.locator(".viewport-stage canvas").boundingBox();
  const relative = projectPoint(
    new THREE.Vector3(
      crateObject.transform.position[0],
      crateObject.transform.position[1] + 0.5,
      crateObject.transform.position[2],
    ),
    saved.scenes[0].startCamera,
    rect,
  );
  const point = { x: rect.x + relative.x, y: rect.y + relative.y };
  await page.locator(".environment-row").click();
  await page.mouse.click(point.x, point.y);
  assert.equal(
    await page.locator(`[data-object-id="${crateObject.id}"]`).getAttribute("aria-pressed"),
    "true",
    "Invisible crate is pickable through its hitbox",
  );
  await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
  const withHotspot = await project.waitForDocument((document) =>
    document.scenes[0]?.hotspots?.some((hotspot) => hotspot.objectId === crateObject.id),
  );
  assert.ok(withHotspot.scenes[0].hotspots.some((hotspot) => hotspot.objectId === crateObject.id));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
