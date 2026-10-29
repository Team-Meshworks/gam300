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

// No more move buttons, so nudge through the Position panel then go back to the tree
async function nudge(page, name, axis, metres) {
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const field = page.getByRole("textbox", { name: `${name} transform ${axis} (m)`, exact: true });
  await field.fill(String(Number(await field.inputValue()) + metres));
  await field.press("Enter");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
}

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, hasTouch: true });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("dialog", (dialog) => {
    dialog.accept().catch((error) => pageErrors.push(error.message));
  });

  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  const ready = page.getByRole("status").filter({ hasText: "Scene ready" });
  const asset = page.getByRole("button", { name: "Add test-crate", exact: true });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const rows = page.locator(".object-row");
  const stage = page.locator(".viewport-stage");
  await ready.waitFor();
  assert.equal(await page.title(), "Untitled - Spatia");
  assert.equal(await page.getByRole("heading", { name: "Spatia", exact: true }).count(), 1);
  assert.equal(await asset.isEnabled(), true);
  assert.equal(await rows.count(), 0);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.ok(
    await asset.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  assert.equal(await page.getByText("Start with a sample model.", { exact: true }).count(), 0);

  await page.keyboard.press("Tab");
  assert.equal(
    await page.getByRole("link", { name: "Skip to scene" }).evaluate((link) => {
      return link === document.activeElement && link.getBoundingClientRect().top >= 0;
    }),
    true,
  );
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator("#viewport").evaluate((view) => view === document.activeElement),
    true,
  );
  await asset.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Choose a room first" }).waitFor();
  assert.equal(await rows.count(), 0, "A crate cannot start a project without an environment");
  assert.equal(await undo.isDisabled(), true);

  // A viewport drop follows the same room-first rule as the asset's Add button
  await asset.dragTo(stage, { targetPosition: { x: 500, y: 200 } });
  assert.equal(await rows.count(), 0, "Dropping a crate before choosing a room changes nothing");
  assert.equal(await undo.isDisabled(), true);
  await page.getByText("Add a room from the asset library to start.", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Add test-room", exact: true }).click();
  await ready.waitFor();
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "Choosing a room clears the placement error",
  );
  // Load a known camera pose so pointer checks do not depend on the editor startup view
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const emptyFixture = structuredClone(fixture);
  emptyFixture.scenes[0].objects = [];
  await page.locator("#project-import").setInputFiles({
    name: "pointer-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(emptyFixture)),
  });
  await page.getByText("Project opened", { exact: true }).waitFor();
  await asset.click();
  assert.equal(await rows.count(), 1);
  const firstId = await rows.first().getAttribute("data-object-id");
  const disclosure = page.locator(".environment-row").locator("..").locator(".scene-disclosure");
  await disclosure.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
  assert.equal(await rows.first().isVisible(), false);
  assert.equal(await rows.first().getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowRight");
  assert.equal(await rows.first().isVisible(), true);
  assert.equal(await rows.first().getAttribute("data-object-id"), firstId);
  await page.keyboard.press("Space");
  assert.equal(await rows.first().isVisible(), false);
  await page.keyboard.press("Enter");
  assert.equal(await rows.first().isVisible(), true);
  const stageBox = await stage.boundingBox();
  assert.ok(stageBox);
  // Find an exposed canvas point without assuming where the asset panel is docked
  const dropPoint = await stage.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (const y of [0.25, 0.4, 0.6]) {
      for (const x of [0.7, 0.3, 0.5]) {
        if (
          document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y)
            ?.tagName === "CANVAS"
        ) {
          return { x: rect.width * x, y: rect.height * y };
        }
      }
    }
    throw new Error("No exposed canvas point for asset drop");
  });
  await asset.dragTo(stage, { targetPosition: dropPoint });
  assert.equal(await rows.count(), 2, "One completed drop creates one object");
  const secondId = await rows.nth(1).getAttribute("data-object-id");
  assert.notEqual(firstId, secondId);
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");

  // Read the authored spawn position before projecting it through the fixture camera
  await rows.first().click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const spawn = await Promise.all(
    ["X", "Y", "Z"].map(async (axis) =>
      Number(
        await page
          .getByRole("textbox", { name: `test-crate 1 transform ${axis} (m)`, exact: true })
          .inputValue(),
      ),
    ),
  );
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const pose = fixture.scenes[0].startCamera;
  const camera = new THREE.PerspectiveCamera(
    pose.fovDegrees,
    stageBox.width / stageBox.height,
    0.1,
    100,
  );
  camera.position.fromArray(pose.position);
  camera.quaternion.fromArray(pose.rotation);
  camera.updateMatrixWorld(true);
  const center = new THREE.Vector3(spawn[0], spawn[1] + 0.5, spawn[2]).project(camera);
  const libraryControl = page.getByRole("button", { name: "Asset library", exact: true });
  await libraryControl.click();
  await stage.click({
    position: {
      x: ((center.x + 1) * stageBox.width) / 2,
      y: ((1 - center.y) * stageBox.height) / 2,
    },
  });
  assert.equal(
    await rows.first().getAttribute("aria-pressed"),
    "true",
    "Viewport and list share selection",
  );
  const position = page.locator('output[aria-label="Selected position"]');
  const initialPosition = await position.textContent();
  await nudge(page, "test-crate 1", "X", 0.25);
  assert.notEqual(await position.textContent(), initialPosition);
  await undo.click();
  assert.equal(await position.textContent(), initialPosition);

  const origin = new THREE.Vector3(...spawn).project(camera);
  const xAxis = new THREE.Vector3(spawn[0] + 1, spawn[1], spawn[2]).project(camera);
  const axisDirection = new THREE.Vector2(
    (xAxis.x - origin.x) * stageBox.width,
    -(xAxis.y - origin.y) * stageBox.height,
  ).normalize();
  const pivot = {
    x: stageBox.x + ((origin.x + 1) * stageBox.width) / 2,
    y: stageBox.y + ((1 - origin.y) * stageBox.height) / 2,
  };
  const alongAxis = (pixels) => ({
    x: pivot.x + axisDirection.x * pixels,
    y: pivot.y + axisDirection.y * pixels,
  });
  await page.mouse.move(alongAxis(40).x, alongAxis(40).y);
  await page.mouse.down();
  await page.mouse.move(alongAxis(75).x, alongAxis(75).y, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await position.textContent(), initialPosition, "Escape cancels preview movement");
  await page.mouse.move(alongAxis(40).x, alongAxis(40).y);
  await page.mouse.down();
  await page.mouse.move(alongAxis(75).x, alongAxis(75).y, { steps: 4 });
  await page.locator("canvas").evaluate((canvas) => canvas.releasePointerCapture(1));
  await page.mouse.up();
  assert.equal(await position.textContent(), initialPosition, "Lost capture cancels movement");
  await page.mouse.move(alongAxis(40).x, alongAxis(40).y);
  await page.mouse.down();
  await page.mouse.move(alongAxis(75).x, alongAxis(75).y, { steps: 4 });
  await page.mouse.up();
  const movedPosition = await position.textContent();
  assert.notEqual(movedPosition, initialPosition, "Pointer drag commits movement");
  await undo.click();
  assert.equal(await position.textContent(), initialPosition, "One Undo reverses the whole drag");

  // A second finger must neither replace nor cancel the first finger's transaction
  const touchSession = await page.context().newCDPSession(page);
  const touchPoint = (pixels, id) => ({ ...alongAxis(pixels), id });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(40, 1)],
  });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [touchPoint(75, 1)],
  });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(75, 1), touchPoint(100, 2)],
  });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [touchPoint(75, 1), touchPoint(115, 2)],
  });
  // Check foreign capture loss without inventing a cancellation for a nonexistent browser pointer
  // CDP owns the real touch sequence and its final cancellation/release events
  await stage.locator("canvas").dispatchEvent("lostpointercapture", { pointerId: 999 });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touchSession.detach();
  assert.equal(await position.textContent(), movedPosition, "Only the initiating touch moves");
  await undo.click();
  assert.equal(await position.textContent(), initialPosition, "Touch drag is one undo step");
  await rows.nth(1).click();
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true");
  if (process.env.CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.CHECK_SCREENSHOT, fullPage: true });
  }

  await libraryControl.click();
  await asset.dragTo(page.getByRole("heading", { name: "Asset library", exact: true }));
  assert.equal(await rows.count(), 2, "Dropping outside the scene leaves objects unchanged");
  const tileBox = await asset.boundingBox();
  assert.ok(tileBox);
  await page.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + dropPoint.x, stageBox.y + dropPoint.y, { steps: 8 });
  await page.getByText("Drop to place", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await rows.count(), 2, "Escape cancels placement");
  await page.getByText("Drop to place", { exact: true }).waitFor({ state: "hidden" });
  const externalPayload = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData("application/x-vthere-asset", "unrecognized-asset");
    return transfer;
  });
  await stage.dispatchEvent("drop", { dataTransfer: externalPayload });
  assert.equal(await rows.count(), 2, "External or unknown asset payloads cannot add objects");
  await externalPayload.dispose();

  await undo.click();
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.first().getAttribute("data-object-id"), firstId);
  await redo.click();
  assert.equal(
    await rows.nth(1).getAttribute("data-object-id"),
    secondId,
    "Redo preserves identity and order",
  );
  await undo.click();
  await asset.click();
  assert.equal(await rows.count(), 2);
  assert.notEqual(await rows.nth(1).getAttribute("data-object-id"), secondId);
  assert.equal(await redo.isDisabled(), true, "A new addition clears the redo branch");

  for (const width of [1366, 1024, 760, 320]) {
    await page.setViewportSize({ width, height: 768 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      const host = document.querySelector(".viewport-stage");
      return (
        canvas &&
        host &&
        Math.abs(canvas.clientWidth - host.clientWidth) <= 1 &&
        Math.abs(canvas.clientHeight - host.clientHeight) <= 1 &&
        Math.abs(canvas.width - host.clientWidth * Math.min(devicePixelRatio, 2)) <= 1
      );
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `No overflow at ${width}px`,
    );
    assert.equal(await page.locator("canvas").count(), 1);
    assert.equal(await rows.count(), 2);
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = "20px"));
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "No overflow at 320px with 125% text size",
  );
  await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
  // A wider fallback font catches columns that only fit on the developer's machine
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
    document.documentElement.style.fontFamily = "Verdana, sans-serif";
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "No overflow at 320px with enlarged text and a wider font",
  );
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
    document.documentElement.style.removeProperty("font-family");
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".asset-art")
      .first()
      .evaluate((art) => getComputedStyle(art).transitionDuration),
    "0s",
  );
  await page.setViewportSize({ width: 1366, height: 768 });

  // Toolbar can dock on any edge and remember it, then go back to the bottom for the rest
  const grip = page.getByRole("button", { name: "Move toolbar", exact: true });
  const dock = page.locator(".bottom-dock");
  const dockMenu = page.getByRole("group", { name: "Dock toolbar" });
  await grip.click();
  await dockMenu.getByRole("button", { name: "Right", exact: true }).click();
  assert.equal(await dock.getAttribute("data-edge"), "right");
  assert.equal(
    await page.locator(".scene-toolbar").evaluate((bar) => getComputedStyle(bar).flexDirection),
    "column",
    "A side dock turns the toolbar vertical",
  );
  assert.equal(await page.evaluate(() => localStorage.getItem("spatia-dock-edge")), "right");
  const gripBox = await grip.boundingBox();
  assert.ok(gripBox);
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + 8, stageBox.y + stageBox.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(await dock.getAttribute("data-edge"), "left", "Dragging snaps to the nearest edge");
  assert.equal(await dockMenu.count(), 0, "A drag does not also open the dock menu");
  await grip.click();
  await dockMenu.getByRole("button", { name: "Bottom", exact: true }).click();
  assert.equal(await dock.getAttribute("data-edge"), "bottom");

  assert.deepEqual(consoleErrors, [], "No console errors during normal authoring");

  await page.getByRole("button", { name: "Add test-room", exact: true }).click();
  assert.equal(
    await rows.count(),
    3,
    "Another room is placed without replacing the existing crates",
  );
  const crateId = await rows.last().getAttribute("data-object-id");
  await undo.click();
  assert.equal(await rows.count(), 2);
  await redo.click();
  assert.equal(await rows.last().getAttribute("data-object-id"), crateId);

  // The saved fixture should replace placement history and show its two authored objects
  await page.getByRole("button", { name: "Open sample project", exact: true }).click();
  // Project replacement now waits for the editor confirmation
  await page.getByRole("dialog").getByRole("button", { name: "Don’t Save", exact: true }).click();
  // Project switching writes recovery data before replacing the scene
  // Wait for the dialog to close before reading the new objects
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(await rows.allTextContents(), ["First crate", "Second crate"]);
  assert.deepEqual(await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)), [
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  const room = page.getByRole("button", { name: "Add test-room", exact: true });
  assert.equal(await room.isVisible(), true, "Opening a project keeps the room in the library");
  const roomRow = page.locator(".environment-row");
  assert.equal(await roomRow.textContent(), fixture.scenes[0].name);
  assert.equal(await page.locator(".panel-count").textContent(), "3");
  await roomRow.click();
  assert.equal(await roomRow.getAttribute("aria-pressed"), "true");
  // Reuse the same room tile and undo only its newly placed instance
  await room.click();
  assert.equal(await rows.count(), 3);
  await undo.click();
  assert.deepEqual(await rows.allTextContents(), ["First crate", "Second crate"]);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), false);
  await asset.click();
  assert.equal(await rows.count(), 3);
  await undo.click();
  assert.equal(await rows.count(), 2);
  await redo.click();
  assert.equal(await rows.count(), 3);
  await page.getByRole("button", { name: "Open sample project", exact: true }).click();
  // Project replacement now waits for the editor confirmation
  await page.getByRole("dialog").getByRole("button", { name: "Don’t Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await rows.count(), 2);
  assert.equal(await page.locator("canvas").count(), 1);
  if (process.env.SCENE_SCREENSHOT) {
    await page.screenshot({ path: process.env.SCENE_SCREENSHOT });
  }

  await rows.nth(1).click();
  await nudge(page, "Second crate", "Z", 1);
  await rows.first().click();
  // Asset panel floats over this part of the scene, close it first so the click reach the wall
  const library = page.getByRole("button", { name: "Asset library", exact: true });
  await library.click();
  const hiddenCrate = new THREE.Vector3(-1, 0.5, 3).project(camera);
  await stage.click({
    position: {
      x: ((hiddenCrate.x + 1) * stageBox.width) / 2,
      y: ((1 - hiddenCrate.y) * stageBox.height) / 2,
    },
  });
  assert.equal(
    await page.locator('.object-row[aria-pressed="true"]').count(),
    0,
    "A room wall blocks viewport selection of the crate behind it",
  );
  assert.equal(
    await roomRow.getAttribute("aria-pressed"),
    "true",
    "Clicking the wall selects the room in the hierarchy",
  );
  await rows.nth(1).click();
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true", "List bypasses occlusion");
  assert.equal(await roomRow.getAttribute("aria-pressed"), "false");
  await library.click();

  // Finish the nudge's automatic backup before opening the project menu
  // Backup temporarily disables New; its timer must not interrupt the pointer click
  // Check the persisted edit rather than sleeping for an assumed storage duration
  await page.waitForFunction(async (expectedZ) => {
    const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
    const result = await loadRecoverySession(
      new Map([
        ["test-room-v1", "environment"],
        ["test-crate-v1", "model"],
        ["sample-snowglobe-v1", "model"],
      ]),
    );
    return (
      result.ok &&
      result.value?.document?.scenes[0]?.objects[1]?.transform.position[2] === expectedZ
    );
  }, fixture.scenes[0].objects[1].transform.position[2] + 1);

  // New projects and recovered sessions should show the same asset choices
  await page.locator(".draft-menu summary").click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Don’t Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("Add a room from the asset library to start.", { exact: true }).waitFor();
  assert.equal(await room.isVisible(), true);
  await room.click();
  await roomRow.waitFor();
  assert.equal(await rows.count(), 0);
  assert.equal(await undo.isDisabled(), true);
  // Choosing a room follows the blank New record; wait for its backup before reloading
  let roomBackedUp = false;
  const backupDeadline = Date.now() + 10000;
  while (Date.now() < backupDeadline) {
    roomBackedUp = await page.evaluate(async () => {
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const result = await loadRecoverySession(
        new Map([
          ["test-room-v1", "environment"],
          ["test-crate-v1", "model"],
          ["sample-snowglobe-v1", "model"],
        ]),
      );
      return result.ok && result.value?.document?.scenes[0]?.objects.length === 0;
    });
    if (roomBackedUp) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(roomBackedUp, true, "The selected room is backed up before refresh");
  await page.reload();
  await ready.waitFor();
  assert.equal(await room.isVisible(), true, "Recovery keeps the room in the library");
  await roomRow.waitFor();
  assert.equal(await page.locator(".panel-count").textContent(), "1");

  const samplePath = "**/*test-crate*.glb*";
  await page.route(samplePath, (route) => {
    // Vite also serves a JavaScript URL module for each model
    // Fail the model download after the application itself has loaded
    return route.request().resourceType() === "script"
      ? route.continue()
      : route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Couldn't load the 3D view" }).waitFor();
  assert.equal(await asset.isDisabled(), true);
  await page.unroute(samplePath);
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.focus();
  await page.keyboard.press("Enter");
  await ready.waitFor();
  assert.equal(await page.locator("canvas").count(), 1, "Retry replaces the old canvas");
  assert.equal(await asset.isEnabled(), true);
  assert.equal(await retry.count(), 0);

  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === "webgl2" ? null : original.call(this, type, ...args);
    };
  });
  await page.reload();
  const unsupported = page.getByRole("status").filter({ hasText: "The 3D view needs WebGL 2" });
  await unsupported.waitFor();
  await retry.click();
  await unsupported.waitFor();
  assert.equal(await page.locator("canvas").count(), 0);
  assert.equal(await asset.isDisabled(), true);
  assert.deepEqual(pageErrors, [], "No uncaught page errors in any flow");
  // Object parenting uses selection and drag/drop without a separate group form
  const nestedContext = await browser.newContext();
  try {
    const nested = await nestedContext.newPage();
    await nested.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
    await nested.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    const addRoom = nested.getByRole("button", { name: "Add test-room", exact: true });
    const addCrate = nested.getByRole("button", { name: "Add test-crate", exact: true });
    await addRoom.click();
    await addCrate.click();
    const parent = nested.locator("[data-object-id]").first();
    await parent.click();
    const labelX = await parent
      .locator("span")
      .evaluate((element) => element.getBoundingClientRect().x);
    await addCrate.click();
    assert.equal(await parent.locator("../..").locator("[data-object-id]").count(), 2);
    assert.equal(
      await parent.locator("span").evaluate((element) => element.getBoundingClientRect().x),
      labelX,
    );
    const sizes = await nested
      .locator(".object-row, .environment-row")
      .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).fontSize));
    assert.equal(new Set(sizes).size, 1, "All tree levels use the parent font size");
    await addRoom.click();
    const roomInstance = nested.locator("[data-object-id]").filter({ hasText: "test-room" });
    await roomInstance.click();
    await addCrate.click();
    assert.equal(await roomInstance.locator("../..").locator("[data-object-id]").count(), 2);
    const child = roomInstance.locator("../..").locator("[data-object-id]").last();
    const movedId = await child.getAttribute("data-object-id");
    // Inspect the hover state before release as well as the resulting parent after a real drop
    const transfer = await nested.evaluateHandle(() => new DataTransfer());
    await child.dispatchEvent("dragstart", { dataTransfer: transfer });
    await parent.dispatchEvent("dragover", { dataTransfer: transfer });
    // Wait for React to render feedback after synthetic drag events
    await nested.locator("[data-drop-target]").waitFor();
    assert.equal(await parent.locator("..").getAttribute("data-drop-target"), "true");
    await child.dispatchEvent("dragend", { dataTransfer: transfer });
    await nested.locator("[data-drop-target]").waitFor({ state: "detached" });
    await transfer.dispose();
    await child.dragTo(parent);
    assert.equal(await parent.locator("../..").locator("[data-object-id]").count(), 3);
    assert.equal(await nested.getByRole("button", { name: "New group", exact: true }).count(), 0);
    assert.equal(await nested.getByRole("combobox").count(), 0);
    // Inline renaming is a single edit; cancelling must never alter the authored name
    await parent.dblclick();
    const rename = nested.getByRole("textbox", { name: /^Rename / });
    await rename.fill("Display pedestal");
    await rename.press("Enter");
    assert.equal(await parent.textContent(), "Display pedestal");
    await parent.press("F2");
    // Cancelling a draft must preserve both the name and the horizontal scroll width
    const treeWidth = await nested
      .locator(".scene-tree")
      .evaluate((element) => element.scrollWidth);
    await rename.fill("Cancelled name");
    await rename.press("Escape");
    assert.equal(
      await nested.locator(".scene-tree").evaluate((element) => element.scrollWidth),
      treeWidth,
    );
    assert.equal(await parent.textContent(), "Display pedestal");
    await nested.getByRole("button", { name: "Undo", exact: true }).click();
    assert.match(await parent.textContent(), /test-crate/);
    await nested.getByRole("button", { name: "Redo", exact: true }).click();
    assert.equal(await parent.textContent(), "Display pedestal");
    await roomInstance.dragTo(parent);
    await nested
      .getByRole("alert")
      .filter({ hasText: "Rooms must remain at the scene root" })
      .waitFor();
    // Keyboard moves and undo use the same parent validation as pointer drops
    const moved = nested.locator(`[data-object-id="${movedId}"]`);
    await moved.press("Control+x");
    await roomInstance.press("Control+v");
    assert.equal(
      await roomInstance.locator("../..").locator(`[data-object-id="${movedId}"]`).count(),
      1,
    );
    await nested.getByRole("button", { name: "Undo", exact: true }).click();
    assert.equal(await parent.locator("../..").locator(`[data-object-id="${movedId}"]`).count(), 1);
    // The first room is stored as the scene, so exercise its rename separately
    await nested.locator(".environment-row").press("F2");
    await nested.getByRole("textbox", { name: /^Rename / }).fill("Main gallery");
    await nested.getByRole("textbox", { name: /^Rename / }).press("Enter");
    assert.equal(await nested.locator(".environment-row").textContent(), "Main gallery");
  } finally {
    await nestedContext.close();
  }

  console.log(
    "PASS: placement, single-pointer movement, cancellation, room occlusion, project loading, undo/redo, keyboard, resizing, retry and WebGL fallback",
  );
} finally {
  await browser.close();
}
