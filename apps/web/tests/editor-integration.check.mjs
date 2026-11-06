import { launchBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name) {
  if (name === "Starter room") {
    if (await page.locator(".asset-picker").count()) await page.keyboard.press("Escape");
    const overview = page.getByRole("button", { name: "Third person", exact: true });
    if ((await overview.getAttribute("aria-pressed")) !== "true") await overview.click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  } else {
    await openLibrary(page);
    await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }
  await placeAtRoomCenter(page);
  await page.locator(".viewport-stage[data-placing-asset]").waitFor({ state: "hidden" });
}

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
    // Hold the first real backup's completion so shortcut coverage cannot miss it.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === "session") {
        IDBObjectStore.prototype.put = put;
        const transaction = this.transaction;
        const complete = transaction.oncomplete;
        transaction.oncomplete = (event) => {
          window.finishBackup = () => complete.call(transaction, event);
        };
      }
      return request;
    };
  });
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await addAsset(page, "Starter room");
  await page.waitForFunction(() => typeof window.finishBackup === "function");
  await addAsset(page, "Sample crate");
  const position = await page.getByLabel("Selected position").textContent();
  assert.equal(
    await page.getByRole("button", { name: "Preview", exact: true }).isEnabled(),
    true,
    "Preview remains available during backup",
  );
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  for (const key of [
    "Control+d",
    "Control+s",
    "Control+Shift+s",
    "Control+z",
    "Control+v",
    "Delete",
  ])
    await page.keyboard.press(key);
  assert.equal(await page.evaluate(() => window.auditPickers), 0, "Navigation cannot open Save");
  assert.equal(await page.locator(".object-row").count(), 1, "Navigation cannot edit the draft");
  for (const selector of [".library", ".history-controls", ".project-card"])
    assert.equal(await page.locator(selector).evaluate((element) => element.inert), true);
  // Preview takes the whole bottom bar away, so got nothing left to click
  assert.equal(await page.locator(".bottom-dock").count(), 0, "Preview hides the asset library");
  assert.equal(await page.locator(".object-row").count(), 1);
  assert.equal(
    await page.getByLabel("Selected position", { includeHidden: true }).textContent(),
    position,
  );
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await page.keyboard.press("Control+d");
  assert.equal(await page.locator(".object-row").count(), 2, "Authoring resumes on exit");
  await page.keyboard.press("Control+z");
  assert.equal(await page.locator(".object-row").count(), 1);
  await page.keyboard.press("Control+y");
  assert.equal(await page.locator(".object-row").count(), 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.evaluate(() => window.finishBackup());
  let scene;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !scene) {
    scene = await page.evaluate(async () => {
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const saved = await loadRecoverySession(
        new Map(assets.map((asset) => [asset.id, asset.kind])),
      );
      return saved.ok &&
        saved.value?.document.scenes[0].objects.length === 1 &&
        saved.value.history?.future.length === 1
        ? saved.value.document.scenes[0]
        : null;
    });
    if (!scene) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(scene, "Recovery history did not reach the expected edit");
  // A deferred wheel commit must not edit the document behind a project decision
  await page.locator(".object-row").first().click();
  const box = await page.locator("canvas").boundingBox();
  // Use the completed backup's camera and object pose instead of editor startup constants
  const camera = new THREE.PerspectiveCamera(
    scene.startCamera.fovDegrees,
    box.width / box.height,
    0.1,
    100,
  );
  camera.position.fromArray(scene.startCamera.position);
  camera.quaternion.fromArray(scene.startCamera.rotation);
  camera.updateMatrixWorld(true);
  const point = new THREE.Vector3(...scene.objects[0].transform.position)
    .add(new THREE.Vector3(0, 0.5, 0))
    .project(camera);
  await page.waitForFunction(
    ({ x, y }) => {
      const newButton = [...document.querySelectorAll(".draft-menu button")].find(
        (button) => button.textContent === "New",
      );
      if (newButton.disabled) return false;
      const wheel = new WheelEvent("wheel", {
        deltaY: -120,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      document.querySelector("canvas").dispatchEvent(wheel);
      if (!wheel.defaultPrevented) throw new Error("Wheel fixture missed the selected object");
      newButton.click();
      return true;
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
    const clicks = [];
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
          onObjectClick: (id) => clicks.push(id),
          onUpdate() {},
          onSelect() {},
          onTransform: (...args) => commits.push(args),
        },
      );
    } finally {
      THREE.Object3D.prototype.add = originalAdd;
    }
    await ready;
    try {
      await handle.prepareAsset("test-crate-v1");
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
      const install = (pose) => {
        handle.update([object], object.id, { ...fixture.scenes[0], startCamera: pose });
        // Explicit camera navigation is distinct from editing a saved starting pose.
        handle.showCamera(pose);
      };
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
      const savedPose = fixture.scenes[0].startCamera;
      const savedScene = { ...fixture.scenes[0], startCamera: savedPose };
      handle.update([object], object.id, savedScene, 1);
      await frame();
      manager.orbit.enableDamping = false;
      manager.orbit.rotateLeft(0.4);
      manager.update(0);
      const navigatedPosition = camera.position.clone();
      handle.update([object], null, savedScene, 1);
      await frame();
      const selectionCameraDrift = camera.position.distanceTo(navigatedPosition);
      handle.update([{ ...object, name: "Edited" }], object.id, savedScene, 1);
      await frame();
      const editCameraDrift = camera.position.distanceTo(navigatedPosition);
      const navigatedRotation = camera.quaternion.clone();
      handle.update(
        [object],
        object.id,
        { ...savedScene, startCamera: { ...savedPose, position: [7, 9, 11] } },
        1,
      );
      await frame();
      const savedCameraEditDrift =
        camera.position.distanceTo(navigatedPosition) +
        camera.quaternion.angleTo(navigatedRotation);
      handle.update([object], object.id, savedScene, 2);
      await frame();
      const reopenedPositionError = camera.position.distanceTo(
        new THREE.Vector3().fromArray(savedPose.position),
      );
      const reopenedRotationError = camera.quaternion.angleTo(
        new THREE.Quaternion().fromArray(savedPose.rotation),
      );
      // Open clears the selection in the same update, the saved camera still wins
      manager.orbit.rotateLeft(0.4);
      manager.update(0);
      const movedBeforeOpen = camera.position.distanceTo(
        new THREE.Vector3().fromArray(savedPose.position),
      );
      handle.update([object], null, savedScene, 3);
      await frame();
      const openedPositionError = camera.position.distanceTo(
        new THREE.Vector3().fromArray(savedPose.position),
      );
      handle.update([object], object.id, savedScene, 3);
      await frame();
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

      // Preview clicks with a locked mouse aim at the crosshair, not where the lock began
      manager.setMode("visitor");
      camera.updateMatrixWorld(true);
      const ahead = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(6);
      const exhibit = {
        ...object,
        transform: {
          ...object.transform,
          position: camera.position
            .clone()
            .add(ahead)
            .sub(new THREE.Vector3(0, 0.5, 0))
            .toArray(),
        },
      };
      handle.update([exhibit], null);
      await frame();
      const corner = { clientX: rect.left + 50, clientY: rect.top + 50 };
      const press = (type, init) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 7,
            isPrimary: true,
            button: 0,
            bubbles: true,
            cancelable: true,
            ...corner,
            ...init,
          }),
        );
      const setLocked = (locked) => {
        if (locked)
          Object.defineProperty(document, "pointerLockElement", {
            configurable: true,
            get: () => canvas,
          });
        else Reflect.deleteProperty(document, "pointerLockElement");
        document.dispatchEvent(new Event("pointerlockchange"));
      };
      clicks.length = 0;
      // Control: the corner itself is off the exhibit
      press("pointerdown", { pointerType: "touch" });
      press("pointerup", { pointerType: "touch" });
      const cornerClicks = clicks.length;
      setLocked(true);
      press("pointerdown", { pointerType: "mouse" });
      press("pointerup", { pointerType: "mouse" });
      const lockedClicks = [...clicks];
      clicks.length = 0;
      // Looking around while held is a drag, even though the locked mouse never moves on screen
      press("pointerdown", { pointerType: "mouse" });
      press("pointermove", { pointerType: "mouse", movementX: 30, buttons: 1 });
      press("pointerup", { pointerType: "mouse" });
      const draggedClicks = clicks.length;
      setLocked(false);
      manager.setMode("editor");
      handle.update([object], object.id);
      return {
        cornerClicks,
        lockedClicks,
        draggedClicks,
        movedBeforeOpen,
        openedPositionError,
        cameraErrors,
        positionErrors,
        selectionCameraDrift,
        editCameraDrift,
        savedCameraEditDrift,
        reopenedPositionError,
        reopenedRotationError,
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
  assert.ok(measured.selectionCameraDrift < 1e-6, "Selection preserves the live camera");
  assert.ok(measured.editCameraDrift < 1e-6, "Edits preserve the live camera");
  assert.ok(
    measured.savedCameraEditDrift < 1e-6,
    "Editing the saved starting camera preserves the current view",
  );
  assert.ok(measured.reopenedPositionError < 1e-6, "Reopening restores the saved camera position");
  assert.ok(measured.reopenedRotationError < 1e-6, "Reopening restores the saved camera rotation");
  assert.ok(measured.movedBeforeOpen > 0.1, "The camera moved away before Open");
  assert.ok(
    measured.openedPositionError < 1e-6,
    "Open restores the saved camera even when it clears the selection",
  );
  assert.equal(measured.cornerClicks, 0, "The corner where the lock began is off the exhibit");
  assert.deepEqual(
    measured.lockedClicks,
    [fixture.scenes[0].objects[0].id],
    "A locked Preview click activates what the crosshair is on",
  );
  assert.equal(measured.draggedClicks, 0, "Looking around with a locked mouse is not a click");
  assert.equal(measured.hiddenInVisitor, true);
  assert.equal(measured.visibleOnReturn, true);
  assert.equal(measured.unexpectedCommits, 0, "Entering Visitor cancels a pending wheel edit");
  assert.ok(measured.previewScale > 1, "The cancellation check started a real scale preview");
  assert.deepEqual(measured.stoppedDistances, [0, 0]);
  assert.equal(await renderer.locator("canvas").count(), 0, "Disposal removes the renderer");
  assert.deepEqual(errors, []);
  await renderer.close();

  // Real touch input against the real handlers. Nothing here needs a production debug hook
  const touchContext = await browser.newContext({
    viewport: { width: 800, height: 600 },
    hasTouch: true,
  });
  const touchPage = await touchContext.newPage();
  touchPage.on("pageerror", (error) => errors.push(error.message));
  await touchPage.route("**/audit-touch-harness.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="margin:0">
        <div id="host" style="width:800px;height:600px"></div>
        <button id="stick" style="position:fixed;right:0;bottom:0;width:80px;height:80px">Move</button>`,
    }),
  );
  await touchPage.goto(new URL("audit-touch-harness.html", url).href);
  await touchPage.evaluate(async (fixture) => {
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
    const object = {
      ...fixture.scenes[0].objects[0],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    };
    const state = { commits: 0, followSelection: false, selected: object.id };
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
          onObjectClick() {},
          onUpdate() {},
          // Pinches start away from the crate here, so only the carry checks follow the app
          onSelect(id) {
            if (!state.followSelection) return;
            state.selected = id;
            handle.update([object], id);
          },
          onTransform: () => {
            state.commits += 1;
          },
        },
      );
    } finally {
      THREE.Object3D.prototype.add = originalAdd;
    }
    await ready;
    await handle.prepareAsset(object.assetId);
    const manager = handle.modeManager;
    const camera = manager.camera;
    manager.initializeView("third");
    manager.orbit.enableDamping = false;
    handle.setEditingEnabled(true);
    handle.update([object], object.id);
    const gizmo = scene.children.find((child) => child.isGroup && child.children.length === 6);
    const instance = scene.children.find((child) => child.isGroup && child !== gizmo);
    const toScreen = (point) => {
      camera.updateMatrixWorld(true);
      const projected = new THREE.Vector3(...point).project(camera);
      return { x: ((projected.x + 1) * 800) / 2, y: ((1 - projected.y) * 600) / 2 };
    };
    window.harness = {
      state,
      handle,
      manager,
      object,
      savedScene: fixture.scenes[0],
      toScreen,
      reset(selected = object.id) {
        state.commits = 0;
        state.selected = selected;
        handle.update([object], selected);
      },
      // The camera tools really do move the camera, so put it back before aiming at the gizmo
      homeCamera() {
        camera.position.set(12, 16, 18);
        camera.lookAt(0, 0, 0);
        handle.showCamera({
          position: camera.position.toArray(),
          rotation: camera.quaternion.toArray(),
          fovDegrees: 40,
        });
        manager.orbit.enableDamping = false;
      },
      // Somewhere along the first gizmo arm, where a touch picks that handle
      armPoint(pixels) {
        const pivot = toScreen(gizmo.getWorldPosition(new THREE.Vector3()).toArray());
        const end = toScreen(gizmo.children[1].getWorldPosition(new THREE.Vector3()).toArray());
        const length = Math.hypot(end.x - pivot.x, end.y - pivot.y);
        return {
          x: pivot.x + ((end.x - pivot.x) * pixels) / length,
          y: pivot.y + ((end.y - pivot.y) * pixels) / length,
        };
      },
      read: () => ({
        commits: state.commits,
        selected: state.selected,
        scale: instance.scale.x,
        position: instance.position.toArray(),
        camera: camera.position.toArray(),
        cameraRotation: camera.quaternion.toArray(),
        gizmoVisible: gizmo.visible,
        gizmoTip: gizmo.children[1].scale.x,
      }),
    };
  }, fixture);

  const cdp = await touchContext.newCDPSession(touchPage);
  const touch = (type, ...touchPoints) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  const settle = () =>
    touchPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const read = async () => {
    await settle();
    return touchPage.evaluate(() => window.harness.read());
  };
  const reset = (selected) => touchPage.evaluate((id) => window.harness.reset(id), selected);
  const armPoint = (pixels, id) =>
    touchPage.evaluate(
      ([distance, pointId]) => ({ ...window.harness.armPoint(distance), id: pointId }),
      [pixels, id],
    );
  // Well away from the crate, the fingers spread apart vertically
  const pinchA = { x: 60, y: 60, id: 1 };
  const pinchB = (y) => ({ x: 60, y, id: 2 });
  async function pinchOpen() {
    await touch("touchStart", pinchA);
    await touch("touchStart", pinchA, pinchB(160));
    await touch("touchMove", pinchA, pinchB(220));
    await touch("touchMove", pinchA, pinchB(300));
  }
  const atOrigin = [0, 0, 0];
  // Check capture loss for a pointer no edit depends on, the browser only reports its own
  const foreignCaptureLoss = () =>
    touchPage
      .locator("canvas")
      .evaluate((canvas) =>
        canvas.dispatchEvent(
          new PointerEvent("lostpointercapture", { pointerId: 999, pointerType: "touch" }),
        ),
      );

  await pinchOpen();
  const pinching = await read();
  assert.ok(pinching.scale > 1, "A two-finger pinch previews a scale");
  assert.equal(pinching.commits, 0, "A pinch only commits once it ends");
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "Lifting the fingers commits one edit");
  await reset();

  // Spreading side by side changes neither the height between the fingers nor their angle
  await touch("touchStart", pinchA);
  await touch("touchStart", pinchA, { x: 160, y: 60, id: 2 });
  await touch("touchMove", pinchA, { x: 220, y: 60, id: 2 });
  await touch("touchMove", pinchA, { x: 300, y: 60, id: 2 });
  assert.ok((await read()).scale > 1, "A horizontal pinch scales too");
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "Lifting a horizontal pinch commits one edit");
  await reset();

  await touchPage.evaluate(() => window.harness.manager.setMode("visitor"));
  await pinchOpen();
  await touch("touchEnd");
  const inPreview = await read();
  assert.equal(inPreview.scale, 1, "Preview ignores two-finger transforms");
  assert.equal(inPreview.commits, 0, "Preview creates no edit");
  await touchPage.evaluate(() => window.harness.manager.setMode("editor"));

  for (const tool of ["pan", "orbit"]) {
    await touchPage.evaluate((name) => window.harness.handle.setNavigationTool(name), tool);
    await pinchOpen();
    await touch("touchEnd");
    const withTool = await read();
    assert.equal(withTool.scale, 1, `The ${tool} tool keeps two fingers for the camera`);
    assert.equal(withTool.commits, 0, `The ${tool} tool creates no edit`);
    await touchPage.evaluate(() => window.harness.handle.setNavigationTool("select"));
  }

  await pinchOpen();
  await foreignCaptureLoss();
  assert.ok((await read()).scale > 1, "Another pointer's loss keeps the pinch");
  await touch("touchCancel");
  const cancelledPinch = await read();
  assert.equal(cancelledPinch.scale, 1, "A cancelled pinch restores the object");
  assert.equal(cancelledPinch.commits, 0, "A cancelled pinch creates no edit");

  await pinchOpen();
  assert.ok((await read()).scale > 1);
  await touchPage.evaluate(() => window.harness.manager.setMode("visitor"));
  await touch("touchEnd");
  const leftEditor = await read();
  assert.equal(leftEditor.scale, 1, "Entering Preview mid-pinch restores the object");
  assert.equal(leftEditor.commits, 0, "Entering Preview mid-pinch creates no edit");
  await touchPage.evaluate(() => window.harness.manager.setMode("editor"));

  await pinchOpen();
  assert.ok((await read()).scale > 1);
  await touchPage.evaluate(() => window.harness.handle.setNavigationTool("pan"));
  await touch("touchEnd");
  const switchedTool = await read();
  assert.equal(switchedTool.scale, 1, "Picking a camera tool mid-pinch restores the object");
  assert.equal(switchedTool.commits, 0, "Picking a camera tool mid-pinch creates no edit");
  await touchPage.evaluate(() => window.harness.handle.setNavigationTool("select"));

  // An undo or another edit replaced the object, the old pinch mustnt write over it
  await pinchOpen();
  assert.ok((await read()).scale > 1);
  await touchPage.evaluate(() => {
    const { handle, object } = window.harness;
    handle.update([{ ...object, transform: { ...object.transform } }], object.id);
  });
  await touch("touchEnd");
  assert.equal((await read()).commits, 0, "A replaced object ends the pinch without an edit");
  await reset();

  // Once a pinch owns the fingers the camera holds still
  await touch("touchStart", pinchA);
  await touch("touchStart", pinchA, pinchB(160));
  await touch("touchMove", pinchA, pinchB(220));
  const claimed = await read();
  await touch("touchMove", { ...pinchA, x: 160, y: 140 }, pinchB(400));
  await touch("touchMove", { ...pinchA, x: 260, y: 200 }, pinchB(500));
  assert.deepEqual((await read()).camera, claimed.camera, "A pinch doesnt also move the camera");
  await touch("touchEnd");
  await reset();

  // A third finger is not part of the pinch, the object mustnt jump when the pair changes
  await pinchOpen();
  await touch("touchStart", pinchA, pinchB(300), { x: 400, y: 60, id: 3 });
  await touch("touchEnd", pinchA);
  const liftedOne = await read();
  assert.equal(liftedOne.commits, 1, "Lifting a pinching finger ends the pinch");
  await touch("touchMove", pinchB(120), { x: 500, y: 500, id: 3 });
  assert.equal((await read()).scale, liftedOne.scale, "The remaining fingers no longer scale");
  await touch("touchEnd");
  await reset();

  await touchPage.evaluate(() => window.harness.homeCamera());
  await reset();
  await settle();
  await touch("touchStart", await armPoint(40, 1));
  await touch("touchMove", await armPoint(75, 1));
  assert.notDeepEqual((await read()).position, atOrigin, "One finger on a handle drags");
  await touch("touchCancel");
  const cancelledDrag = await read();
  assert.deepEqual(cancelledDrag.position, atOrigin, "A cancelled drag restores the object");
  assert.equal(cancelledDrag.commits, 0, "A cancelled drag creates no edit");
  // The camera has to have its input back too, or the cancelled drag is still holding it
  await touch("touchStart", await armPoint(40, 1));
  const start = await armPoint(40, 1);
  await touch("touchMove", { ...start, x: start.x + 30 });
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "A new drag works after a cancelled one");
  await reset();

  // A lift also reports lost capture, and it mustnt cancel the other finger's drag
  const dragging = await armPoint(75, 1);
  await touch("touchStart", await armPoint(40, 1));
  await touch("touchMove", dragging);
  await touch("touchStart", dragging, { x: 60, y: 60, id: 2 });
  // touchEnd lifts the fingers it names
  await touch("touchEnd", { x: 60, y: 60, id: 2 });
  assert.notDeepEqual((await read()).position, atOrigin, "Lifting a second finger keeps the drag");
  await foreignCaptureLoss();
  assert.notDeepEqual((await read()).position, atOrigin, "Another pointer's loss keeps the drag");
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "The first finger's drag still commits");
  await reset();

  // A drag handed to a pinch has only moved the preview, so cancelling goes back past it
  const moved = await armPoint(75, 1);
  await touch("touchStart", await armPoint(40, 1));
  await touch("touchMove", moved);
  await touch("touchStart", moved, { x: moved.x, y: moved.y + 100, id: 2 });
  await touch("touchMove", moved, { x: moved.x, y: moved.y + 160, id: 2 });
  await touch("touchMove", moved, { x: moved.x, y: moved.y + 260, id: 2 });
  // Losing the capture is only reported on that finger's next event, so move it again
  await touch("touchMove", { ...moved, x: moved.x + 2 }, { x: moved.x, y: moved.y + 280, id: 2 });
  const handedOver = await read();
  assert.ok(handedOver.scale > 1, "The drag hands over to a pinch that keeps running");
  assert.notDeepEqual(handedOver.position, atOrigin, "The pinch carries on from the moved preview");
  await touch("touchCancel");
  const cancelledHandover = await read();
  assert.deepEqual(cancelledHandover.position, atOrigin, "Cancelling restores the authored pose");
  assert.equal(cancelledHandover.scale, 1);
  assert.equal(cancelledHandover.commits, 0, "Cancelling a handed-over pinch creates no edit");

  // A stationary touch on the crate must not interrupt the camera's jump or fall.
  async function jumpInterval(delay, click) {
    await touchPage.evaluate(() => {
      const h = window.harness;
      h.manager.setView("first");
      h.handle.showCamera({ position: [0, 0.9, 6], rotation: [0, 0, 0, 1], fovDegrees: 40 });
      h.reset(null);
      h.state.followSelection = true;
      h.handle.mobileControls.jump();
    });
    await touchPage.waitForTimeout(delay);
    const before = await read();
    if (click) {
      const point = await touchPage.evaluate(() => window.harness.toScreen([0, 0.5, 0]));
      await touch("touchStart", { ...point, id: 9 });
    }
    await touchPage.waitForTimeout(100);
    if (click) await touch("touchEnd");
    const after = await read();
    return { displacement: after.camera[1] - before.camera[1], before, after };
  }
  for (const [label, delay] of [
    ["descent", 430],
    ["ascent", 80],
  ]) {
    const baseline = await jumpInterval(delay, false);
    const clicked = await jumpInterval(delay, true);
    assert.ok(
      label === "ascent" ? baseline.displacement > 0 : baseline.displacement < 0,
      `Baseline is ${label}`,
    );
    assert.equal(
      clicked.after.selected,
      await touchPage.evaluate(() => window.harness.object.id),
      `The ${label} click hits the crate`,
    );
    assert.ok(
      Math.abs(clicked.displacement - baseline.displacement) < 0.08,
      `A stationary click preserves ${label}: ${JSON.stringify({ baseline, clicked })}`,
    );
    assert.equal(
      clicked.after.commits,
      clicked.before.commits,
      `A click creates no ${label} history`,
    );
    assert.deepEqual(
      clicked.after.position,
      clicked.before.position,
      `A click creates no ${label} transform`,
    );
  }

  // A saved camera keeps its pose in first person, walking starts from there
  await touchPage.evaluate(() => {
    const { handle, manager } = window.harness;
    manager.setView("first");
    handle.showCamera({ position: [0, 2, 10], rotation: [0, 0, 0, 1], fovDegrees: 40 });
  });
  assert.deepEqual((await read()).camera, [0, 2, 10], "First person keeps a restored pose");
  const rolledPose = {
    position: [0, 0.25, 6],
    rotation: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)],
    fovDegrees: 40,
  };
  await touchPage.evaluate((pose) => window.harness.handle.showCamera(pose), rolledPose);
  let restored = await read();
  assert.deepEqual(
    restored.camera,
    rolledPose.position,
    "Restoring preserves a low authored height",
  );
  assert.ok(
    Math.abs(
      restored.cameraRotation.reduce(
        (sum, value, index) => sum + value * rolledPose.rotation[index],
        0,
      ),
    ) > 0.99999,
    "Restoring preserves authored roll",
  );
  await touchPage.evaluate((pose) => {
    const h = window.harness;
    h.handle.update([h.object], h.object.id, { ...h.savedScene, startCamera: pose }, 123);
  }, rolledPose);
  restored = await read();
  assert.deepEqual(
    restored.camera,
    rolledPose.position,
    "Reopening preserves the low starting position",
  );
  assert.ok(
    Math.abs(
      restored.cameraRotation.reduce(
        (sum, value, index) => sum + value * rolledPose.rotation[index],
        0,
      ),
    ) > 0.99999,
    "Reopening preserves authored roll",
  );
  const verticalPose = {
    position: [0, 0.25, 6],
    rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    fovDegrees: 40,
  };
  await touchPage.evaluate((pose) => window.harness.handle.showCamera(pose), verticalPose);
  const vertical = await read();
  assert.ok(
    Math.abs(
      vertical.cameraRotation.reduce(
        (sum, value, index) => sum + value * verticalPose.rotation[index],
        0,
      ),
    ) > 0.99999,
    "An authored vertical view remains exact until the user looks",
  );

  await touchPage.evaluate(() =>
    window.harness.handle.showCamera({
      position: [0, 0.9, 6],
      rotation: [0, 1, 0, 0],
      fovDegrees: 40,
    }),
  );
  assert.equal((await read()).gizmoVisible, false, "Gizmo hides behind the first-person camera");
  await touchPage.evaluate(() => window.harness.handle.mobileControls.setLook(Math.PI / 0.002, 0));
  assert.equal((await read()).gizmoVisible, true, "Turning toward selection reveals the gizmo");
  await touchPage.evaluate(() => {
    window.harness.handle.showCamera({
      position: [0, 0.9, 6],
      rotation: [0, 0, 0, 1],
      fovDegrees: 40,
    });
  });
  assert.deepEqual((await read()).camera, [0, 0.9, 6]);

  // The gizmo keeps a steady size on screen, so walking has to refresh it
  const walk = (x, z) =>
    touchPage.evaluate(
      ([moveX, moveZ]) => window.harness.handle.mobileControls.setMove(moveX, moveZ),
      [x, z],
    );
  const tipBefore = (await read()).gizmoTip;
  await walk(0, -1);
  await touchPage.waitForTimeout(300);
  await walk(0, 0);
  assert.notEqual((await read()).gizmoTip, tipBefore, "Walking refreshes the gizmo");
  await touchPage.evaluate(() => {
    const { state, handle } = window.harness;
    state.followSelection = true;
    handle.showCamera({ position: [0, 0.9, 6], rotation: [0, 0, 0, 1], fovDegrees: 40 });
  });
  await reset(null);
  const crate = await touchPage.evaluate(() => window.harness.toScreen([0, 0.5, 0]));
  const onCrate = { ...crate, id: 1 };
  const objectId = await touchPage.evaluate(() => window.harness.object.id);

  await touch("touchStart", onCrate);
  await touch("touchEnd");
  const tapped = await read();
  assert.equal(tapped.selected, objectId, "A tap in first person selects without pointer lock");
  assert.equal(tapped.commits, 0, "A tap carries nothing");
  assert.deepEqual(tapped.position, atOrigin);
  await reset(null);

  // One finger moves the object freely, not along a single gizmo axis
  await touch("touchStart", onCrate);
  await touch("touchMove", { ...onCrate, x: crate.x + 120, y: crate.y - 60 });
  const followed = await read();
  assert.ok(followed.position[0] > 0.1, "The object follows the finger sideways");
  assert.ok(followed.position[1] > 0.1, "The object follows the finger upwards");
  await touch("touchMove", { ...onCrate, x: crate.x + 200, y: crate.y - 60 });
  assert.ok((await read()).position[0] > followed.position[0], "It keeps following the finger");
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "One finger drag is one edit");
  await reset(objectId);
  // The selected object's gizmo runs through it, the object still wins over the arrows
  await touch("touchStart", onCrate);
  await touch("touchMove", { ...onCrate, x: crate.x + 120 });
  const overGizmo = await read();
  assert.ok(overGizmo.position[0] > 0.1, "A finger on a selected object moves it freely");
  await touch("touchCancel");
  assert.deepEqual((await read()).position, atOrigin);
  await reset(null);

  // Holding the Move stick makes it the primary touch, the object still has to pick up
  const stickBox = await touchPage.locator("#stick").boundingBox();
  const stick = { x: stickBox.x + 40, y: stickBox.y + 40, id: 5 };
  await touch("touchStart", stick);
  await touch("touchStart", stick, onCrate);
  assert.equal((await read()).selected, objectId, "A press while walking still reaches the scene");
  await walk(0, -1);
  await touchPage.waitForTimeout(300);
  await walk(0, 0);
  assert.notDeepEqual(
    (await read()).position,
    atOrigin,
    "Holding carries the object while walking",
  );
  await touch("touchEnd", stick);
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "Letting go puts it down as one edit");
  await touchPage.evaluate(() => {
    window.harness.handle.showCamera({
      position: [0, 0.9, 6],
      rotation: [0, 0, 0, 1],
      fovDegrees: 40,
    });
  });
  await reset(null);

  await touch("touchStart", onCrate);
  await walk(0, -1);
  await touchPage.waitForTimeout(300);
  await walk(0, 0);
  assert.notDeepEqual((await read()).position, atOrigin);
  await touch("touchCancel");
  const cancelledCarry = await read();
  assert.deepEqual(cancelledCarry.position, atOrigin, "A cancelled carry puts the object back");
  assert.equal(cancelledCarry.commits, 0, "A cancelled carry creates no edit");
  await touchPage.evaluate(() => {
    window.harness.handle.showCamera({
      position: [0, 0.9, 6],
      rotation: [0, 0, 0, 1],
      fovDegrees: 40,
    });
  });
  await reset(null);

  // A second finger takes the object over from a carry
  const second = (above) => ({ x: crate.x, y: crate.y - above, id: 2 });
  await touch("touchStart", onCrate);
  await touch("touchStart", onCrate, second(100));
  await touch("touchMove", onCrate, second(160));
  await touch("touchMove", onCrate, second(260));
  const tookOver = await read();
  assert.ok(tookOver.scale > 1, "A second finger starts a transform during a carry");
  await touch("touchEnd");
  assert.equal((await read()).commits, 1, "The takeover is one edit");
  // The environment-backed first room must carry by touch just like added room objects.
  await touchPage.evaluate(async (fixture) => {
    window.harness.handle.dispose();
    const { initScene } = await import("/graphics/scene.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const scene = {
      ...fixture.scenes[0],
      objects: [],
      startCamera: { position: [0, 1.6, 3], rotation: [0, 0, 0, 1], fovDegrees: 40 },
    };
    const state = { commits: 0, transform: null };
    const { promise, resolve } = Promise.withResolvers();
    const handle = initScene(
      document.getElementById("host"),
      assets.filter((asset) => asset.id === "test-room-v1"),
      {
        onStatus(status) {
          if (status === "ready") resolve();
        },
        onThumbnail() {},
        onSelect() {},
        onObjectClick() {},
        onUpdate() {},
        onTransform(_id, transform) {
          state.commits++;
          state.transform = transform;
        },
      },
    );
    handle.modeManager.initializeView("first");
    handle.update([], scene.id, scene, 0, [scene.id]);
    await promise;
    window.roomTouch = { handle, state, camera: handle.modeManager.camera };
    window.roomTouch.before = [
      ...window.roomTouch.camera.position.toArray(),
      ...window.roomTouch.camera.quaternion.toArray(),
    ];
  }, fixture);
  await touch("touchStart", { x: 400, y: 300, id: 1 });
  await touch("touchMove", { x: 450, y: 300, id: 1 });
  await touchPage.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await touch("touchEnd");
  const roomTouch = await touchPage.evaluate(() => ({
    commits: window.roomTouch.state.commits,
    transform: window.roomTouch.state.transform,
    before: window.roomTouch.before,
    after: [
      ...window.roomTouch.camera.position.toArray(),
      ...window.roomTouch.camera.quaternion.toArray(),
    ],
  }));
  assert.equal(
    roomTouch.commits,
    1,
    "Touching and dragging the first room body must commit a move",
  );
  assert.ok(
    Math.abs(roomTouch.transform.position[0]) > 0.1,
    "A touch drag must move the first room",
  );
  roomTouch.after.forEach((number, index) =>
    assert.ok(
      Math.abs(number - roomTouch.before[index]) < 1e-6,
      "Dragging the first room by touch preserves the camera",
    ),
  );
  await touchPage.evaluate(() => window.roomTouch.handle.dispose());
  await cdp.detach();
  await touchContext.close();

  // The sticks have to fit and show whichever way up the device is held
  const phone = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1",
  });
  const phonePage = await phone.newPage();
  phonePage.on("pageerror", (error) => errors.push(error.message));
  await phonePage.goto(url);
  await phonePage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await phonePage.setViewportSize(viewport);
    const sticks = phonePage.locator(".mobile-joystick");
    assert.equal(await sticks.count(), 2);
    for (const name of ["Move", "Look"]) {
      const box = await phonePage.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box !== null, `${name} shows at ${viewport.width}x${viewport.height}`);
      assert.ok(
        box.x >= 0 && box.x + box.width <= viewport.width,
        `${name} fits at ${viewport.width}x${viewport.height}`,
      );
    }
    const left = await phonePage.getByRole("button", { name: "Move", exact: true }).boundingBox();
    const right = await phonePage.getByRole("button", { name: "Look", exact: true }).boundingBox();
    const jump = await phonePage.locator(".mobile-jump-button").boundingBox();
    assert.equal(left.width, left.height, "Move stays round");
    assert.equal(right.width, right.height, "Look stays round");
    assert.ok(left.x + left.width <= jump.x, "Move and Jump dont overlap");
    assert.ok(jump.x + jump.width <= right.x, "Jump and Look dont overlap");
  }
  await phone.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: visitor authoring isolation, camera restoration, zoomed gizmos, mode cancellation, focus cleanup and touch gestures",
  );
} finally {
  await browser.close();
}
