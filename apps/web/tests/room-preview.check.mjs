import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5185/",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5185/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Filters", exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("group", { name: "Camera tools", exact: true }).isVisible(),
    true,
  );
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  // Observe viewport-owned room clones so connection checks never inspect or alter cached source models
  const captureRooms = () =>
    page.evaluate(async () => {
      const { editorModelCache } = await import("/graphics/scene.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const lease = await editorModelCache.acquire(
        assets.find((asset) => asset.id === "test-room-v1"),
        new AbortController().signal,
      );
      const prototype = Object.getPrototypeOf(Object.getPrototypeOf(lease.value.model));
      const add = prototype.add;
      window.roomRoots = [];
      prototype.add = function (...nodes) {
        for (const node of nodes) {
          if (node.name === "placement-preview") window.roomGhost = node;
          else if (this.isScene && node.getObjectByName("Wall_Back")) window.roomRoots.push(node);
        }
        return add.apply(this, nodes);
      };
      lease.release();
    });
  await captureRooms();
  async function choose() {
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name: "Starter room", exact: true })
      .click();
  }
  async function saved(count, matches = () => true) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const doc = await page.evaluate(async () => {
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
        const r = await loadRecoverySession(new Map(assets.map((a) => [a.id, a.kind])));
        return r.ok ? r.value?.document : null;
      });
      if (doc?.scenes[0].objects.length === count && matches(doc)) return doc;
      await page.waitForTimeout(100);
    }
    throw new Error("Room placement did not reach storage");
  }
  const stage = page.locator(".viewport-stage");
  await choose();
  await stage.click({ position: { x: 600, y: 350 } });
  let doc = await saved(0);
  await choose();
  let outside;
  const diagnostics = [];
  for (const point of [
    { x: 1400, y: 100 },
    { x: 1400, y: 200 },
    { x: 1100, y: 100 },
    { x: 500, y: 100 },
    { x: 1350, y: 800 },
    { x: 500, y: 850 },
  ]) {
    await stage.hover({ position: point });
    const red = await page.evaluate(() => {
      let color;
      window.roomGhost?.traverse((node) => {
        if (node.isMesh) color = node.material.color.getHexString();
      });
      return window.roomGhost?.visible && color === "c84637";
    });
    diagnostics.push(
      await page.evaluate(() => ({
        position: window.roomGhost?.position.toArray(),
        visible: window.roomGhost?.visible,
      })),
    );
    if (red) {
      outside = point;
      break;
    }
  }
  assert.ok(outside, "A room beyond the grid must remain visible as a red preview");
  await mkdir("test-results/room-entrances", { recursive: true });
  await page.screenshot({ path: "test-results/room-entrances/invalid-room.png" });
  await stage.click({ position: outside });
  assert.equal(
    await page.locator(".scene-tree .object-row").count(),
    0,
    "Clicking an invalid room preview cannot add a room",
  );
  assert.equal(
    await stage.getAttribute("data-placing-asset"),
    "test-room-v1",
    "Invalid clicks keep placement active",
  );
  await stage.hover({ position: { x: 600, y: 350 } });
  assert.equal(
    await page.evaluate(() => {
      let color;
      window.roomGhost.traverse((node) => {
        if (node.isMesh) color = node.material.color.getHexString();
      });
      return color;
    }),
    "999999",
    "Returning to the grid restores the grey preview",
  );
  await page.keyboard.press("Escape");
  for (let count = 1; count <= 2; count++) {
    await choose();
    await stage.hover({ position: { x: 600, y: 350 } });
    const preview = await page.evaluate(() => {
      const ghost = window.roomGhost;
      ghost.updateMatrixWorld(true);
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      ghost.traverse((node) => {
        const points = node.geometry?.attributes.position;
        if (!points) return;
        const e = node.matrixWorld.elements;
        for (let i = 0; i < points.count; i++) {
          const x = points.getX(i),
            y = points.getY(i),
            z = points.getZ(i);
          const point = [
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          ];
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], point[axis]);
            max[axis] = Math.max(max[axis], point[axis]);
          }
        }
      });
      return { position: ghost.position.toArray(), min, max };
    });
    for (const position of [[0, 0, 0], ...doc.scenes[0].objects.map((o) => o.transform.position)]) {
      const overlapX =
          Math.min(preview.max[0], position[0] + 5) - Math.max(preview.min[0], position[0] - 5),
        overlapZ =
          Math.min(preview.max[2], position[2] + 5) - Math.max(preview.min[2], position[2] - 5);
      assert.ok(
        overlapX < 1e-5 || overlapZ < 1e-5,
        "Unplaced floor must not overlap an existing room floor",
      );
    }
    await stage.click({ position: { x: 600, y: 350 } });
    doc = await saved(count);
    assert.deepEqual(doc.scenes[0].objects.at(-1).transform.position, preview.position);
    const openedWalls = await page.evaluate(() => {
      let count = 0;
      for (const root of window.roomRoots)
        root.traverse((node) => {
          if (node.name.startsWith("Wall_") && node.geometry.attributes.position.count > 24)
            count++;
        });
      return count;
    });
    assert.equal(openedWalls, count * 2, "Every connection must open both shared walls");
  }
  await page.evaluate(() => {
    let mesh;
    window.roomRoots.at(-1).traverse((node) => {
      if (node.isMesh) mesh = node;
    });
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      window.roomCamera = camera;
    };
    window.originalCanvas = document.querySelector("canvas");
  });
  await page.waitForFunction(() => window.roomCamera);
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await page.mouse.move(1120, 750);
  await page.mouse.down();
  await page.mouse.move(1190, 780, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const pose = [
      ...window.roomCamera.position.toArray(),
      ...window.roomCamera.quaternion.toArray(),
    ];
    const stable =
      window.lastCameraPose &&
      pose.every((number, index) => Math.abs(number - window.lastCameraPose[index]) < 1e-8);
    window.lastCameraPose = pose;
    window.cameraStableFrames = stable ? (window.cameraStableFrames ?? 0) + 1 : 0;
    return window.cameraStableFrames >= 3;
  });
  const livePose = () =>
    page.evaluate(() => [
      ...window.roomCamera.position.toArray(),
      ...window.roomCamera.quaternion.toArray(),
      window.roomCamera.fov,
    ]);
  const expectedLivePose = await livePose();
  const assertLiveCamera = async (step) => {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await page.evaluate(() => window.originalCanvas.isConnected),
      true,
      `${step}: canvas stays mounted`,
    );
    (await livePose()).forEach((number, index) =>
      assert.ok(
        Math.abs(number - expectedLivePose[index]) < 1e-6,
        `${step}: camera position, orientation and field of view stay fixed`,
      ),
    );
  };
  // Exercise visible Ctrl/Shift selection before checking that one command moves the selected layout
  const tree = page.locator(".scene-tree");
  const firstRow = tree.locator(".environment-row");
  const rows = tree.locator(".object-row");
  await firstRow.click();
  await rows.last().click({ modifiers: ["Shift"] });
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 3);
  // A plain viewport pick replaces the range instead of reviving it on the next object click
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await stage.click({ position: { x: 1400, y: 2 } });
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 0);
  const roomPoint = await page.evaluate(() => {
    const room = window.roomRoots[1];
    const point = room.getWorldPosition(room.position.clone());
    point.y += 1;
    point.project(window.roomCamera);
    const canvas = document.querySelector("canvas");
    return {
      x: ((point.x + 1) * canvas.clientWidth) / 2,
      y: ((1 - point.y) * canvas.clientHeight) / 2,
    };
  });
  await stage.click({ position: roomPoint });
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 1);
  await firstRow.click();
  await rows.last().click({ modifiers: ["Shift"] });
  const selectedRows = await tree.locator('[aria-pressed="true"]').evaluateAll((rows) =>
    rows.map((row) => ({
      top: row.getBoundingClientRect().top,
      bottom: row.getBoundingClientRect().bottom,
      outline: getComputedStyle(row).outlineColor,
    })),
  );
  for (let i = 1; i < selectedRows.length; i++)
    assert.ok(
      selectedRows[i].top - selectedRows[i - 1].bottom >= 4,
      "Selected row highlights must remain separate",
    );
  assert.notEqual(
    selectedRows.at(-1).outline,
    "rgb(174, 69, 46)",
    "Hierarchy focus does not use the red accent",
  );
  await rows.first().click({ modifiers: ["Control"] });
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 2);
  await rows.first().click({ modifiers: ["Control"] });
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 3);
  await firstRow.click();
  await rows.last().click({ modifiers: ["Shift"] });
  await assertLiveCamera("hierarchy multi-selection");
  const beforeMove = doc;
  const last = doc.scenes[0].objects.at(-1);
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const x = page.getByRole("textbox", { name: `${last.name} transform X (m)`, exact: true });
  await x.fill(String(last.transform.position[0] + 3));
  await x.press("Enter");
  doc = await saved(2, (value) => value.scenes[0].environmentTransform?.position[0] === 3);
  assert.deepEqual(
    doc.scenes[0].objects.map((object) => object.transform.position),
    beforeMove.scenes[0].objects.map((object) => [
      object.transform.position[0] + 3,
      0,
      object.transform.position[2],
    ]),
  );
  await assertLiveCamera("numeric group translation");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  assert.equal(await tree.locator('[aria-pressed="true"]').count(), 3);
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  assert.equal(
    await page.getByRole("group", { name: "Camera tools", exact: true }).isVisible(),
    false,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("group", { name: "Camera tools", exact: true }).isVisible(),
    true,
  );
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await page.evaluate(() => {
    let mesh;
    window.roomRoots.at(-1).traverse((node) => {
      if (node.isMesh) mesh = node;
    });
    const before = mesh.onBeforeRender;
    mesh.onBeforeRender = function (renderer, scene, camera, ...rest) {
      window.roomCamera = camera;
      before.call(this, renderer, scene, camera, ...rest);
    };
  });
  await page.waitForFunction(() => window.roomCamera);
  // Project real gizmo handles rather than relying on screen coordinates tied to one camera pose
  const projectedHandle = (index = 0) =>
    page.evaluate((index) => {
      const scene = window.roomRoots[0].parent;
      const gizmo = scene.children.find(
        (node) => node.isGroup && node.children.length === 6 && node.children[0].isLineSegments,
      );
      scene.updateMatrixWorld(true);
      const camera = window.roomCamera;
      const V = gizmo.position.constructor;
      const project = (point) => {
        const p = point.project(camera),
          r = document.querySelector("canvas").getBoundingClientRect();
        return { x: r.x + ((p.x + 1) * r.width) / 2, y: r.y + ((1 - p.y) * r.height) / 2 };
      };
      const start = project(gizmo.getWorldPosition(new V()));
      const end = project(gizmo.children[index * 2 + 1].getWorldPosition(new V()));
      const length = Math.hypot(end.x - start.x, end.y - start.y),
        dx = (end.x - start.x) / length,
        dy = (end.y - start.y) / length;
      return {
        from: { x: start.x + dx * 40, y: start.y + dy * 40 },
        to: { x: start.x + dx * 70, y: start.y + dy * 70 },
      };
    }, index);
  const axis = await projectedHandle();
  await page.mouse.move(axis.from.x, axis.from.y);
  await page.mouse.down();
  await page.mouse.move(axis.to.x, axis.to.y, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await assertLiveCamera("cancelled group drag");
  const cancelled = await page.evaluate(() =>
    window.roomRoots.map((root) => root.position.toArray()),
  );
  assert.ok(
    Math.abs(cancelled[0][0] - 3) < 1e-5,
    "Escape restores the initial room's live position",
  );
  await page.mouse.move(axis.from.x, axis.from.y);
  await page.mouse.down();
  await page.mouse.move(axis.to.x, axis.to.y, { steps: 5 });
  await page.mouse.up();
  const dragged = await saved(
    2,
    (value) => value.scenes[0].environmentTransform?.position[0] !== 3,
  );
  await assertLiveCamera("group handle drag");
  const delta = dragged.scenes[0].environmentTransform.position[0] - 3;
  assert.ok(Math.abs(delta) > 0.1, "Dragging a move handle must move the selected rooms");
  for (let i = 0; i < 2; i++)
    assert.ok(
      Math.abs(
        dragged.scenes[0].objects[i].transform.position[0] -
          doc.scenes[0].objects[i].transform.position[0] -
          delta,
      ) < 1e-5,
    );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await saved(2, (value) => value.scenes[0].environmentTransform?.position[0] === 3);
  await assertLiveCamera("group movement Undo");
  await rows.last().click();
  for (const index of [1, 0, 2]) {
    const handle = await projectedHandle(index);
    const original = doc.scenes[0].objects.at(-1).transform.position;
    const otherCoordinate =
      (doc.scenes[0].environmentTransform.position[index] +
        doc.scenes[0].objects[0].transform.position[index]) /
      2;
    const direction = index === 1 || original[index] >= otherCoordinate ? 1 : -1;
    await page.mouse.move(handle.from.x, handle.from.y);
    await page.mouse.down();
    await page.mouse.move(
      handle.from.x + (handle.to.x - handle.from.x) * direction,
      handle.from.y + (handle.to.y - handle.from.y) * direction,
      { steps: 5 },
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await assertLiveCamera(`single-room axis ${index} drag preview`);
    const live = await page.evaluate(() => window.roomRoots.at(-1).position.toArray());
    assert.ok(
      Math.abs(live[index] - original[index]) > 0.1,
      "Move handles must show movement before release",
    );
    await page.mouse.up();
    await saved(2, (value) =>
      value.scenes[0].objects
        .at(-1)
        .transform.position.every((number, axis) => Math.abs(number - original[axis]) < 1e-5),
    );
    await assertLiveCamera(`single-room axis ${index} release and snap`);
    const committed = await page.evaluate(() => window.roomRoots.at(-1).position.toArray());
    committed.forEach((number, axis) =>
      assert.ok(
        Math.abs(number - original[axis]) < 1e-5,
        "Releasing a short room drag must reconnect instead of saving a gap",
      ),
    );
  }
  const wallNames = () =>
    page.evaluate(() => {
      const names = [];
      window.roomRoots.at(-1).traverse((node) => {
        if (node.name.startsWith("Wall_") && node.geometry.attributes.position.count > 24)
          names.push(node.name);
      });
      return names;
    });
  const previousOpenings = await wallNames();
  await rows.last().click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const yaw = page.getByRole("textbox", { name: `${last.name} rotation Y (°)`, exact: true });
  await yaw.fill("90");
  await yaw.press("Enter");
  doc = await saved(
    2,
    (value) => Math.abs(value.scenes[0].objects.at(-1).transform.rotation[1]) > 0.7,
  );
  assert.notDeepEqual(
    await wallNames(),
    previousOpenings,
    "Rotating a room must move its doorway to the newly shared local wall",
  );
  await assertLiveCamera("numeric room rotation and doorway update");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await saved(2);
  await mkdir("test-results/room-entrances", { recursive: true });
  await page.screenshot({ path: "test-results/room-entrances/three-rooms.png" });
  await page.locator(".scene-tree .environment-row").click();
  await page.keyboard.press("Delete");
  await page.locator(".scene-tree .environment-row").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".scene-tree .object-row").count(),
    2,
    "Deleting the initial room preserves other rooms",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".scene-tree .environment-row").waitFor();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.locator(".scene-tree .environment-row").waitFor({ state: "hidden" });
  // Removing every room must leave a recoverable empty scene that still accepts a new first room
  for (let remaining = 2; remaining > 0; remaining--) {
    await page.locator(".scene-tree .object-row").first().click();
    await page.keyboard.press("Delete");
    assert.equal(await page.locator(".scene-tree .object-row").count(), remaining - 1);
  }
  await saved(0, (value) => value.scenes[0].environmentVisible === false);
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator(".scene-tree .environment-row").count(), 0);
  assert.equal(await page.locator(".scene-tree .object-row").count(), 0);
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await captureRooms();
  await choose();
  await stage.click({ position: { x: 600, y: 350 } });
  const remaining = await saved(1);
  assert.equal(await page.locator(".scene-tree .environment-row").count(), 0);
  assert.equal(
    await page.locator(".scene-tree .object-row").count(),
    1,
    "A room can be placed after deleting the last one",
  );
  await page.evaluate(() => {
    let mesh;
    window.roomRoots.at(-1).traverse((node) => {
      if (node.isMesh) mesh = node;
    });
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      window.roomCamera = camera;
    };
    window.originalCanvas = document.querySelector("canvas");
  });
  await page.waitForFunction(() => window.roomCamera);
  await page.evaluate(() => {
    window.roomCamera.position.x += 2;
    window.roomCamera.position.y += 1;
    window.roomCamera.position.z += 3;
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const cameraPose = () =>
    page.evaluate(() => [
      ...window.roomCamera.position.toArray(),
      ...window.roomCamera.quaternion.toArray(),
      window.roomCamera.fov,
    ]);
  const beforeCamera = await cameraPose();
  const assertCamera = async () => {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await page.evaluate(() => window.originalCanvas.isConnected),
      true,
      "Transform edits must not recreate the viewport",
    );
    (await cameraPose()).forEach((number, axis) =>
      assert.ok(
        Math.abs(number - beforeCamera[axis]) < 1e-6,
        "Transform edits and history must preserve the live camera",
      ),
    );
  };
  await page.locator(".scene-tree .object-row").click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const remainingRoom = remaining.scenes[0].objects[0];
  const field = page.getByRole("textbox", {
    name: `${remainingRoom.name} transform X (m)`,
    exact: true,
  });
  await field.fill(String(remainingRoom.transform.position[0] + 1));
  await field.press("Enter");
  await saved(
    1,
    (value) =>
      value.scenes[0].objects[0].transform.position[0] === remainingRoom.transform.position[0] + 1,
  );
  await assertCamera();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await assertCamera();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await assertCamera();
  const rotation = page.getByRole("textbox", {
    name: `${remainingRoom.name} rotation Y (°)`,
    exact: true,
  });
  await rotation.fill("45");
  await rotation.press("Enter");
  await saved(1, (value) => Math.abs(value.scenes[0].objects[0].transform.rotation[1]) > 0.3);
  await assertCamera();
  const alignment = await page.locator(".axis-fields label").evaluateAll((labels) =>
    labels.map((label) => {
      const axis = label.querySelector("span").getBoundingClientRect(),
        input = label.querySelector("input").getBoundingClientRect();
      return Math.abs(axis.y + axis.height / 2 - input.y - input.height / 2);
    }),
  );
  alignment.forEach((offset) =>
    assert.ok(offset < 0.5, "Axis labels must be vertically centered with their fields"),
  );
  await page.screenshot({ path: "test-results/room-entrances/position-centered.png" });
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await choose();
  await stage.hover({ position: { x: 600, y: 350 } });
  const previewRotation = await page.evaluate(() => window.roomGhost.quaternion.toArray());
  const expectedRotation = (await saved(1)).scenes[0].objects[0].transform.rotation;
  previewRotation.forEach((number, axis) =>
    assert.ok(
      Math.abs(number - expectedRotation[axis]) < 1e-8,
      "Room preview follows the remaining rotated layout",
    ),
  );
  await stage.click({ position: { x: 600, y: 350 } });
  const joined = await saved(2);
  joined.scenes[0].objects[1].transform.rotation.forEach((number, axis) =>
    assert.ok(
      Math.abs(number - expectedRotation[axis]) < 1e-8,
      "Newly placed rooms match the preview rotation",
    ),
  );
  const openings = await page.evaluate(() => {
    let count = 0;
    for (const root of window.roomRoots)
      root.traverse((node) => {
        if (node.name.startsWith("Wall_") && node.geometry.attributes.position.count > 24) count++;
      });
    return count;
  });
  assert.equal(
    openings,
    2,
    "Rotated rooms connect through both shared walls after the starter room was deleted",
  );
  await assertCamera();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await saved(1);
  await assertCamera();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await saved(2);
  await assertCamera();
  assert.deepEqual(errors, [], "Room workflows must not produce uncaught errors or console errors");

  console.log(
    "PASS: room placement/bounds, rotating entrances, Ctrl/Shift selection, group and XYZ handle drags, snap-on-release, deletion/reopen, and camera position/orientation/FOV preservation through transforms and history.",
  );
} finally {
  await browser.close();
}
