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

// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name) {
  await openLibrary(page);
  await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
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
  const picker = page.locator(".asset-picker");
  const asset = picker.getByRole("button", { name: "test-crate", exact: true });
  const add = page.getByRole("button", { name: "Add", exact: true });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const rows = page.locator(".object-row");
  const stage = page.locator(".viewport-stage");
  // Library covers the middle of the scene, so drop halfway between it and the right edge
  async function dropPointBesideLibrary() {
    await openLibrary(page);
    const stageBox = await stage.boundingBox();
    const pickerBox = await picker.boundingBox();
    assert.ok(stageBox && pickerBox);
    return {
      x: (pickerBox.x + pickerBox.width + stageBox.x + stageBox.width) / 2 - stageBox.x,
      y: stageBox.height / 2,
    };
  }
  await ready.waitFor();
  assert.equal(await page.title(), "Untitled - Spatia");
  assert.equal(await page.getByRole("heading", { name: "Spatia", exact: true }).count(), 1);
  assert.equal(await picker.count(), 0, "Asset library starts closed");
  assert.equal(await rows.count(), 0);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
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
  await openLibrary(page);
  assert.equal(await asset.isEnabled(), true);
  assert.equal(await add.isDisabled(), true, "Add waits until a card is picked");
  assert.ok(
    await asset.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await asset.focus();
  await page.keyboard.press("Enter");
  assert.equal(await asset.getAttribute("aria-pressed"), "true", "Enter picks the card");
  assert.equal(await rows.count(), 0, "Picking a card alone places nothing");

  // Filtering keeps the pick, and says so when the current results hide it
  const filter = picker.getByRole("combobox", { name: "Filter assets", exact: true });
  const selection = picker.locator(".asset-picker-selection");
  assert.equal(await selection.textContent(), "Selected: test-crate");
  await filter.selectOption("favourites");
  assert.equal(await asset.count(), 0, "No favourites saved, so the crate is filtered out");
  assert.equal(
    await selection.textContent(),
    "Selected: test-crate (not shown in the current results)",
  );
  await filter.selectOption("all");
  assert.equal(await asset.getAttribute("aria-pressed"), "true", "The pick survives filtering");
  await add.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Choose a room first" }).waitFor();
  assert.equal(await rows.count(), 0, "A crate cannot start a project without an environment");
  assert.equal(await undo.isDisabled(), true);

  // A viewport drop follows the same room-first rule as the asset's Add button
  await asset.dragTo(stage, { targetPosition: await dropPointBesideLibrary() });
  assert.equal(await rows.count(), 0, "Dropping a crate before choosing a room changes nothing");
  assert.equal(await undo.isDisabled(), true);
  await page.getByText("Add a room from the asset library to start.", { exact: true }).waitFor();

  await addAsset(page, "test-room");
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
  // Reopening the same document must discard uncommitted scene-form drafts.
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByLabel("Scene name").fill("Uncommitted scene draft");
  await page.locator("#project-import").setInputFiles({
    name: "pointer-fixture-reopened.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(emptyFixture)),
  });
  await page.getByText("pointer-fixture-reopened.json", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Scene name").inputValue(), emptyFixture.scenes[0].name);
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByLabel("View name").fill("Uncommitted view draft");
  await page.locator("#project-import").setInputFiles({
    name: "pointer-fixture-views.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(emptyFixture)),
  });
  await page.getByText("pointer-fixture-views.json", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("View name").inputValue(), "");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await addAsset(page, "test-crate");
  assert.equal(await rows.count(), 1);
  assert.equal(await picker.count(), 0, "Add closes the library");
  const firstId = await rows.first().getAttribute("data-object-id");
  const stageBox = await stage.boundingBox();
  assert.ok(stageBox);
  const dropPoint = await dropPointBesideLibrary();
  await asset.dragTo(stage, { targetPosition: dropPoint });
  assert.equal(await rows.count(), 2, "One completed drop creates one object");
  assert.equal(await picker.count(), 0, "A finished drop closes the library");
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

  await openLibrary(page);
  await asset.dragTo(page.getByRole("heading", { name: "Assets", exact: true }));
  assert.equal(await rows.count(), 2, "Dropping outside the scene leaves objects unchanged");
  assert.equal(await picker.count(), 1, "A drag that misses the scene keeps the library open");
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
  await addAsset(page, "test-crate");
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
  await openLibrary(page);
  assert.equal(
    await page
      .locator(".asset-art")
      .first()
      .evaluate((art) => getComputedStyle(art).transitionDuration),
    "0s",
  );
  await page.keyboard.press("Escape");
  assert.equal(await picker.count(), 0, "Esc closes the library");
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

  await addAsset(page, "test-room");
  assert.equal(
    await rows.count(),
    2,
    "Room becomes the environment; existing crates stay in the project",
  );
  const crateId = await rows.last().getAttribute("data-object-id");
  await undo.click();
  assert.equal(await rows.count(), 1);
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
  const room = picker.getByRole("button", { name: "test-room", exact: true });
  await openLibrary(page);
  assert.equal(await room.isVisible(), true, "Opening a project keeps the room in the library");
  // Library sits over the side panels, close it before using the scene tree
  await page.keyboard.press("Escape");
  const roomRow = page.locator(".environment-row");
  assert.equal(await roomRow.textContent(), "test-room");
  assert.equal(await page.locator(".panel-count").textContent(), "3");
  await roomRow.click();
  assert.equal(await roomRow.getAttribute("aria-pressed"), "true");
  // Reusing the current room must leave the loaded exhibits and history intact
  await addAsset(page, "test-room");
  assert.deepEqual(await rows.allTextContents(), ["First crate", "Second crate"]);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  await page.getByText("This room is already in the scene", { exact: true }).waitFor();
  await addAsset(page, "test-crate");
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

  // Finish the nudge's automatic backup before opening the project menu
  // Backup temporarily disables New; its timer must not interrupt the pointer click
  // Check the persisted edit rather than sleeping for an assumed storage duration
  let nudgeBackedUp = false;
  const nudgeDeadline = Date.now() + 10000;
  while (Date.now() < nudgeDeadline) {
    nudgeBackedUp = await page.evaluate(async (expectedZ) => {
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
    if (nudgeBackedUp) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(nudgeBackedUp, true, "The nudge is backed up before opening New");

  // New projects and recovered sessions should show the same asset choices
  await page.locator(".draft-menu summary").click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Don’t Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("Add a room from the asset library to start.", { exact: true }).waitFor();
  await openLibrary(page);
  assert.equal(await room.isVisible(), true);
  await addAsset(page, "test-room");
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
  await openLibrary(page);
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
  await openLibrary(page);
  assert.equal(await asset.isDisabled(), true);
  await page.unroute(samplePath);
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await retry.focus();
  await page.keyboard.press("Enter");
  await ready.waitFor();
  assert.equal(await page.locator("canvas").count(), 1, "Retry replaces the old canvas");
  await openLibrary(page);
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
  await openLibrary(page);
  assert.equal(await asset.isDisabled(), true);
  assert.deepEqual(pageErrors, [], "No uncaught page errors in any flow");
  console.log(
    "PASS: placement, single-pointer movement, cancellation, room occlusion, project loading, undo/redo, keyboard, resizing, retry and WebGL fallback",
  );
} finally {
  await browser.close();
}
