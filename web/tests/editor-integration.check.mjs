import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as THREE from "three";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.addInitScript(() => {
    window.auditPickers = 0;
    window.showSaveFilePicker = async () => {
      window.auditPickers++;
      throw new DOMException("Cancelled", "AbortError");
    };
  });
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Add test-room", exact: true }).click();
  await page.getByRole("button", { name: "Add test-crate", exact: true }).click();
  const position = await page.getByLabel("Selected position").textContent();
  await page.getByRole("button", { name: "Enter Visitor", exact: true }).click();
  for (const key of ["Control+d", "Control+s", "Control+Shift+s", "Control+z", "Control+v"])
    await page.keyboard.press(key);
  assert.equal(await page.evaluate(() => window.auditPickers), 0, "Navigation cannot open Save");
  assert.equal(await page.locator(".object-row").count(), 1, "Navigation cannot edit the draft");
  for (const selector of [".library", ".history-controls", ".draft-menu"])
    assert.equal(await page.locator(selector).evaluate((element) => element.inert), true);
  // Even a queued library click must be rejected after the mode has changed
  await page.locator('.asset-tile[aria-label="Add test-crate"]').dispatchEvent("click");
  await page.locator(".move-controls button").first().dispatchEvent("click");
  assert.equal(await page.locator(".object-row").count(), 1);
  assert.equal(
    await page.getByLabel("Selected position", { includeHidden: true }).textContent(),
    position,
  );
  await page.getByRole("button", { name: "Exit Visitor", exact: true }).click();
  await page.keyboard.press("Control+d");
  assert.equal(await page.locator(".object-row").count(), 2, "Authoring resumes on exit");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 1);
  // A deferred wheel commit must not edit the document behind a project decision
  await page.locator(".object-row").first().click();
  const box = await page.locator("canvas").boundingBox();
  const camera = new THREE.PerspectiveCamera(40, box.width / box.height, 0.1, 100);
  camera.position.set(12, 16, 18);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const point = new THREE.Vector3(0, 0.5, 0).project(camera);
  await page.evaluate(
    ({ x, y }) => {
      document.querySelector("canvas").dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
      [...document.querySelectorAll(".draft-menu button")]
        .find((button) => button.textContent === "New")
        .click();
    },
    { x: box.x + ((point.x + 1) * box.width) / 2, y: box.y + ((1 - point.y) * box.height) / 2 },
  );
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Don’t Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".object-row").count(),
    0,
    "Pending transforms cannot defeat New",
  );
  await page.close();

  // Exercise the actual renderer and controls without production-only debug hooks
  const renderer = await browser.newPage();
  renderer.on("pageerror", (error) => errors.push(error.message));
  await renderer.route("**/audit-harness.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="host" style="width:800px;height:600px"></div>',
    }),
  );
  await renderer.goto(new URL("audit-harness.html", url).href);
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const measured = await renderer.evaluate(async (fixture) => {
    const source = await (await fetch("/graphics/scene.ts")).text();
    const threePath = source.match(/import \* as THREE from "([^"]+)"/)[1];
    const THREE = await import(threePath);
    const { initScene } = await import("/graphics/scene.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const host = document.getElementById("host");
    const originalAdd = THREE.Object3D.prototype.add;
    let scene;
    THREE.Object3D.prototype.add = function (...objects) {
      if (this.isScene) scene = this;
      return originalAdd.apply(this, objects);
    };
    const { promise: ready, resolve: finish } = Promise.withResolvers();
    const commits = [];
    let handle;
    try {
      handle = initScene(
        host,
        assets.filter((asset) => asset.id === "test-crate-v1"),
        {
          onStatus: (status) => {
            if (status === "ready") finish();
          },
          onThumbnail() {},
          onSelect() {},
          onTransform: (...args) => commits.push(args),
        },
      );
    } finally {
      THREE.Object3D.prototype.add = originalAdd;
    }
    await ready;
    try {
      const manager = handle.modeManager;
      const camera = manager.camera;
      const object = {
        ...fixture.scenes[0].objects[0],
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      };
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const install = (pose) =>
        handle.update([object], object.id, { ...fixture.scenes[0], startCamera: pose });
      const cameraErrors = [];
      const positionErrors = [];
      for (const rotation of [
        [0, 0, 0, 1],
        [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)],
        [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      ]) {
        manager.orbit.rotateLeft(0.5);
        install({ position: [10, 10, 10], rotation, fovDegrees: 40 });
        await frame();
        cameraErrors.push(camera.quaternion.angleTo(new THREE.Quaternion().fromArray(rotation)));
        positionErrors.push(camera.position.distanceTo(new THREE.Vector3(10, 10, 10)));
      }
      install({ ...fixture.scenes[0].startCamera });
      await frame();
      const height = camera.position.y;
      manager.orbit.enableDamping = false;
      manager.orbit.rotateLeft(0.25);
      manager.update(0);
      const orbitHeightError = Math.abs(camera.position.y - height);
      install({ ...fixture.scenes[0].startCamera });
      await frame();
      const gizmo = scene.children.find((child) => child.isGroup && child.children.length === 6);
      function length() {
        scene.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        const start = gizmo.getWorldPosition(new THREE.Vector3()).project(camera);
        const end = gizmo.children[1].getWorldPosition(new THREE.Vector3()).project(camera);
        return Math.hypot(
          ((end.x - start.x) * host.clientWidth) / 2,
          ((end.y - start.y) * host.clientHeight) / 2,
        );
      }
      const beforeZoom = length();
      const canvas = host.querySelector("canvas");
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < 30; i++)
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: 100,
            clientX: rect.right - 8,
            clientY: rect.top + 8,
            bubbles: true,
            cancelable: true,
          }),
        );
      await frame();
      const afterZoom = length();
      install({ ...fixture.scenes[0].startCamera });
      await frame();
      const point = new THREE.Vector3(0, 0.5, 0).project(camera);
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: rect.left + ((point.x + 1) * rect.width) / 2,
          clientY: rect.top + ((1 - point.y) * rect.height) / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
      const previewScale = scene.children.find((child) => child.isGroup && child !== gizmo).scale.x;
      manager.setMode("visitor");
      const hiddenInVisitor = !gizmo.visible;
      handle.update([object], object.id);
      manager.setMode("editor");
      const visibleOnReturn = gizmo.visible;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const unexpectedCommits = commits.length;
      const stoppedDistances = [];
      for (const event of ["blur", "visibilitychange"]) {
        manager.setMode("visitor");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW" }));
        manager.update(0.1);
        if (event === "blur") window.dispatchEvent(new Event("blur"));
        else {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
          Reflect.deleteProperty(document, "hidden");
        }
        const stopped = camera.position.clone();
        for (let i = 0; i < 10; i++) manager.update(0.1);
        stoppedDistances.push(camera.position.distanceTo(stopped));
        manager.setMode("editor");
      }
      return {
        cameraErrors,
        positionErrors,
        orbitHeightError,
        beforeZoom,
        afterZoom,
        hiddenInVisitor,
        visibleOnReturn,
        unexpectedCommits,
        previewScale,
        stoppedDistances,
      };
    } finally {
      handle.dispose();
    }
  }, fixture);
  assert.ok(
    measured.cameraErrors.every((angle) => angle < 1e-6),
    JSON.stringify(measured),
  );
  assert.ok(Math.abs(measured.afterZoom - measured.beforeZoom) < 2, JSON.stringify(measured));
  assert.ok(
    measured.positionErrors.every((distance) => distance < 1e-6),
    JSON.stringify(measured),
  );
  assert.ok(measured.orbitHeightError < 1e-6, "An upright view still orbits around world up");
  assert.equal(measured.hiddenInVisitor, true);
  assert.equal(measured.visibleOnReturn, true);
  assert.equal(measured.unexpectedCommits, 0, "Entering Visitor cancels a pending wheel edit");
  assert.ok(measured.previewScale > 1, "The cancellation check started a real scale preview");
  assert.deepEqual(measured.stoppedDistances, [0, 0]);
  assert.equal(await renderer.locator("canvas").count(), 0, "Disposal removes the renderer");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: visitor authoring isolation, camera restoration, zoomed gizmos, mode cancellation and focus cleanup",
  );
} finally {
  await browser.close();
}
