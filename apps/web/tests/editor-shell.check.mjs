import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});

// No more move buttons, so nudge through the Position panel then go back to the tree
async function nudge(page, name, axis, metres) {
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const field = page.getByRole("textbox", { name: `${name} transform ${axis} (m)`, exact: true });
  await field.fill(String(Number(await field.inputValue()) + metres));
  await field.press("Enter");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
}

async function storedDocuments(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("vthere-local-drafts", 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction(["drafts", "session"], "readonly");
          const drafts = transaction.objectStore("drafts").getAll();
          const sessions = transaction.objectStore("session").getAll();
          transaction.oncomplete = () => {
            database.close();
            resolve([...drafts.result, ...sessions.result].map((record) => record.document).sort());
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
  );
}

// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name, position = { x: 500, y: 300 }) {
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
  await page.locator(".viewport-stage").click({ position });
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
  const asset = picker.getByRole("button", { name: "Sample crate", exact: true });
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
  // The thumbnail sits on the card beside the name button, not inside it
  assert.ok(
    await picker
      .locator(".asset-card")
      .filter({ has: page.getByRole("button", { name: "Sample crate", exact: true }) })
      .locator("img")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await asset.focus();
  await page.keyboard.press("Enter");
  assert.equal(await asset.getAttribute("aria-pressed"), "true", "Enter picks the card");
  assert.equal(await rows.count(), 0, "Picking a card alone places nothing");

  // A short result set fits; the delivered catalogue may legitimately be taller.
  // Exercise growth independently of how many production assets have been registered.
  await picker.getByRole("searchbox", { name: "Search assets", exact: true }).fill("Sample crate");
  assert.equal(await picker.locator(".asset-card").count(), 1);
  const scrollLayout = await picker.locator(".asset-grid-scroll").evaluate((viewport) => {
    const grid = viewport.querySelector(".asset-grid");
    const shortListScrolls = viewport.scrollHeight > viewport.clientHeight;
    const extraCards = Array.from({ length: 45 }, () => grid.firstElementChild.cloneNode(true));
    grid.append(...extraCards);
    const result = {
      shortListScrolls,
      longListScrolls: viewport.scrollHeight > viewport.clientHeight,
      horizontalOverflow: viewport.scrollWidth > viewport.clientWidth,
    };
    extraCards.forEach((card) => card.remove());
    return result;
  });
  assert.deepEqual(scrollLayout, {
    shortListScrolls: false,
    longListScrolls: true,
    horizontalOverflow: false,
  });
  await picker.getByRole("searchbox", { name: "Search assets", exact: true }).fill("");

  // Filtering keeps the pick, and says so when the current results hide it
  const filter = picker.getByRole("combobox", { name: "Filter assets", exact: true });
  // Modal browsing leaves the asset hotbar available while hotspot controls stay inactive.
  // Camera tools stay available while editing, but browsing hides and disables them.
  assert.equal(await page.locator(".mode-bar").isVisible(), false);
  assert.equal(await page.locator(".mode-bar").evaluate((bar) => bar.inert), true);
  assert.equal(
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).isDisabled(),
    true,
  );
  await filter.click();
  const filterMenu = page.getByRole("listbox", { name: "Filter assets" });
  const availableCategories = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    return [
      ...new Set(
        assets
          .filter(
            (item) =>
              item.displayRole === undefined &&
              item.kind === "model" &&
              item.id !== "test-room-module-v1" &&
              item.id !== "test-room-v1",
          )
          .map((item) => item.category)
          .filter(Boolean),
      ),
    ];
  });
  let lastEnabledCategory;
  for (const option of await filterMenu.getByRole("option").all()) {
    const label = (await option.textContent()).trim();
    const available = ["All assets", "Favourites", ...availableCategories].includes(label);
    assert.equal(await option.isDisabled(), !available, `${label} reflects catalogue availability`);
    if (available) lastEnabledCategory = label;
  }
  await page.keyboard.press("Escape");
  assert.equal(await filterMenu.isVisible(), false);
  assert.equal(await picker.isVisible(), true, "First Escape closes only the filter menu");
  // Fast keyboard navigation must use the open menu immediately rather than waiting for its toggle event
  await filter.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await filter.textContent(), lastEnabledCategory);
  await picker.getByRole("button", { name: "Reset asset filters", exact: true }).click();
  // Announce selection without adding a visible footer or changing the library layout
  const selection = picker.locator("#asset-picker-selection");
  assert.equal(await selection.getAttribute("class"), "sr-only");
  assert.equal(await selection.textContent(), "Selected: Sample crate");
  // Search and category filtering keep the selected ID and popup dimensions without editing the draft
  const search = picker.getByRole("searchbox", { name: "Search assets", exact: true });
  const resetFilters = picker.getByRole("button", { name: "Reset asset filters", exact: true });
  const pickerBeforeSearch = await picker.boundingBox();
  await search.fill("  CRATE  ");
  assert.equal(await picker.locator(".asset-card-pick").count(), 1);
  await filter.click();
  await page
    .getByRole("listbox", { name: "Filter assets" })
    .getByRole("option", { name: "Favourites", exact: true })
    .click();
  assert.equal(await picker.locator(".asset-card-pick").count(), 0);
  await picker.getByText("No assets match this search and filter.", { exact: true }).waitFor();
  assert.match(await selection.textContent(), /Sample crate \(not shown/);
  assert.ok(
    Math.abs((await picker.boundingBox()).height - pickerBeforeSearch.height) < 1,
    "Empty results keep the library height stable",
  );
  await search.fill("<script>");
  assert.equal(await picker.locator("script").count(), 0);
  await resetFilters.click();
  assert.equal(await search.inputValue(), "");
  assert.equal(await filter.textContent(), "All assets");
  assert.equal(await asset.getAttribute("aria-pressed"), "true");
  assert.equal(await rows.count(), 0);
  assert.equal(await undo.isDisabled(), true);
  await filter.click();
  await page
    .getByRole("listbox", { name: "Filter assets" })
    .getByRole("option", { name: "Favourites", exact: true })
    .click();
  assert.equal(await asset.count(), 0, "No favourites saved, so the crate is filtered out");
  assert.equal(
    await selection.textContent(),
    "Selected: Sample crate (not shown in the current results)",
  );
  await filter.click();
  await page
    .getByRole("listbox", { name: "Filter assets" })
    .getByRole("option", { name: "All assets", exact: true })
    .click();
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
  await page.getByText("Add a room to start.", { exact: true }).waitFor();

  await addAsset(page, "Starter room");
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
  const placementBox = await stage.boundingBox();
  const placementPose = fixture.scenes[0].startCamera;
  const placementCamera = new THREE.PerspectiveCamera(
    placementPose.fovDegrees,
    placementBox.width / placementBox.height,
    0.1,
    100,
  );
  placementCamera.position.fromArray(placementPose.position);
  placementCamera.quaternion.fromArray(placementPose.rotation);
  placementCamera.updateMatrixWorld();
  const placementPoint = new THREE.Vector3(0, 0, 0).project(placementCamera);
  await addAsset(page, "Sample crate", {
    x: ((placementPoint.x + 1) / 2) * placementBox.width,
    y: ((1 - placementPoint.y) / 2) * placementBox.height,
  });
  assert.equal(await rows.count(), 1);
  assert.equal(await picker.count(), 0, "Add closes the library");
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
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  // Editor starts in first person; the camera toolbar remains available in either editing view.
  const viewToggle = page.getByRole("button", { name: "Third person", exact: true });
  const cameraTools = page.getByRole("group", { name: "Camera tools" });
  const locked = () => page.evaluate(() => document.pointerLockElement?.tagName ?? null);
  assert.equal(await viewToggle.getAttribute("aria-pressed"), "false");
  assert.equal(await cameraTools.isVisible(), true, "Camera tools remain available while editing");
  assert.match(await page.locator(".walk-hint").textContent(), /Click the scene to look around/);
  await viewToggle.click();
  assert.equal(await viewToggle.getAttribute("aria-pressed"), "true");
  assert.equal(await cameraTools.count(), 1);
  await openLibrary(page);
  assert.equal(await page.locator(".mode-bar").evaluate((bar) => bar.inert), true);
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  assert.equal(await picker.count(), 0);
  assert.equal(await page.locator(".mode-bar").evaluate((bar) => bar.inert), false);
  assert.equal(await page.locator(".walk-hint").count(), 0);
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
          .getByRole("textbox", { name: `Sample crate transform ${axis} (m)`, exact: true })
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
  await nudge(page, "Sample crate", "X", 0.25);
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

  // First person stand where the orbit camera looked, so back off the crate then aim at it
  await rows.nth(1).click();
  await viewToggle.click();
  assert.equal(await cameraTools.isVisible(), true);
  await stage.click({ position: { x: stageBox.width / 2, y: stageBox.height / 2 } });
  assert.equal(await locked(), "CANVAS", "A click on the scene grabs the mouse");
  await page.locator(".crosshair").waitFor();
  assert.equal(await page.locator(".crosshair").count(), 1);
  assert.equal(await rows.nth(1).getAttribute("aria-pressed"), "true", "Grabbing picks nothing");
  await page.keyboard.down("s");
  await page.waitForTimeout(600);
  await page.keyboard.up("s");
  // Let the walk glide to a stop, a click while still moving is allowed to carry
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.up();
  assert.equal(await rows.first().getAttribute("aria-pressed"), "true", "Crosshair picks");
  assert.equal(await position.textContent(), initialPosition, "A plain click carries nothing");
  // Holding the click carries it while walking. Backing up keeps it under the crosshair
  await page.mouse.down();
  await page.keyboard.down("s");
  await page.waitForTimeout(300);
  await page.keyboard.up("s");
  await page.mouse.up();
  assert.notEqual(await position.textContent(), initialPosition, "Holding the click carries it");
  await page.keyboard.press("Control+z");
  assert.equal(await position.textContent(), initialPosition, "One Undo puts the carry back");
  // Looking up while carrying lifts it off the floor, then look back down at it
  const centre = { x: stageBox.x + stageBox.width / 2, y: stageBox.y + stageBox.height / 2 };
  const height = async () => Number((await position.textContent()).match(/Y (-?[\d.]+)/)[1]);
  //send mouse movement directly to the page to have a more consistent testing
  // The camera only turns on the next frame, so wait for it before aiming or letting go
  const look = (movementY) =>
    page.evaluate((y) => {
      for (let step = 0; step < 20; step += 1) {
        document.dispatchEvent(new MouseEvent("mousemove", { movementY: y }));
      }
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, movementY);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await look(-8);
  await page.mouse.up();
  console.log("movement seen:", JSON.stringify(await page.evaluate(() => window.lookLog)));
  await page.waitForFunction(
    () => {
      const text = document.querySelector('output[aria-label="Selected position"]')?.textContent;
      const match = text?.match(/Y (-?[\d.]+)/);
      return match !== null && Number(match[1]) > 0.1;
    },
    undefined,
    { timeout: 2000 },
  );
  assert.ok((await height()) > 0.1, "Looking up lifts what is carried");
  await page.keyboard.press("Control+z");
  await look(8);
  assert.equal(await position.textContent(), initialPosition);
  // Scrolling while carrying pushes it away
  await page.mouse.down();
  await page.mouse.wheel(0, -400);
  await page.mouse.up();
  assert.notEqual(await position.textContent(), initialPosition, "Scrolling pushes it away");
  await page.keyboard.press("Control+z");
  assert.equal(await position.textContent(), initialPosition);
  // Holding right click turns it in place, a new edit clears Redo
  assert.ok(await redo.isEnabled());
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centre.x + 120, centre.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  assert.equal(await position.textContent(), initialPosition, "Turning leaves it in place");
  assert.ok(await redo.isDisabled(), "Holding right click turns it");
  await page.keyboard.press("Control+z");
  assert.ok(await redo.isEnabled(), "One Undo puts the turn back");
  // Freeing the mouse mid-carry puts the object back where it was
  await page.mouse.down();
  await page.keyboard.down("s");
  await page.waitForTimeout(300);
  await page.keyboard.up("s");
  await page.keyboard.down("Alt");
  assert.equal(await locked(), null, "Holding Alt gives the mouse back");
  await page.mouse.up();
  assert.equal(await position.textContent(), initialPosition, "Alt cancels the carry");
  await page.keyboard.up("Alt");
  await page.waitForFunction(() => document.pointerLockElement?.tagName === "CANVAS");
  assert.equal(await locked(), "CANVAS", "Letting go of Alt takes it again");
  // Alt clicking a button moves focus to it, so the mouse stays free for the UI
  await page.keyboard.down("Alt");
  await viewToggle.click();
  await page.keyboard.up("Alt");
  assert.equal(await locked(), null);
  assert.equal(await cameraTools.count(), 1, "Back to third person");

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

  // Cancelled drags can leave the library open; dismiss it before using blocked background controls
  if (await picker.isVisible()) {
    await picker.getByRole("button", { name: "Close asset library" }).click();
  }
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
  await addAsset(page, "Sample crate");
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

  await addAsset(page, "Starter room");
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
  const room = picker.getByRole("button", { name: "Starter room", exact: true });
  await openLibrary(page);
  assert.equal(await room.count(), 0, "Rooms belong to their own hotbar popup");
  // Library sits over the side panels, close it before using the scene tree
  await page.keyboard.press("Escape");
  const roomRow = page.locator(".environment-row");
  assert.equal(await roomRow.textContent(), fixture.scenes[0].name);
  assert.equal(await page.locator(".panel-count").textContent(), "3");
  assert.equal(await roomRow.getAttribute("data-scene-id"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await roomRow.click();
  assert.equal(await roomRow.getAttribute("aria-pressed"), "true");
  // Reuse the same room tile and undo only its newly placed instance
  await addAsset(page, "Starter room");
  assert.equal(await rows.count(), 3);
  await undo.click();
  assert.deepEqual(await rows.allTextContents(), ["First crate", "Second crate"]);
  await roomRow.click();
  // Disclosure changes presentation only and must leave the stored draft untouched
  const savedBeforeTree = await storedDocuments(page);
  assert.ok(savedBeforeTree.length > 0);
  await disclosure.click();
  assert.equal(await rows.first().isVisible(), false);
  assert.equal(await roomRow.getAttribute("aria-pressed"), "true");
  await disclosure.click();
  assert.equal(await rows.first().isVisible(), true);
  assert.equal(await roomRow.getAttribute("aria-pressed"), "true");
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), false);
  assert.deepEqual(
    await storedDocuments(page),
    savedBeforeTree,
    "Tree expansion preserves saved JSON",
  );
  await addAsset(page, "Sample crate");
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
  await rows.nth(1).focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await rows.nth(1).getAttribute("aria-pressed"),
    "true",
    "Keyboard tree selection bypasses occlusion",
  );
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
  await page.getByText("Add a room to start.", { exact: true }).waitFor();
  await openLibrary(page);
  assert.equal(await room.count(), 0, "Rooms stay in the Rooms popup after New");
  await addAsset(page, "Starter room");
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
  assert.equal(await room.count(), 0, "Recovery keeps rooms in their own hotbar popup");
  await roomRow.waitFor();
  assert.equal(await page.locator(".panel-count").textContent(), "1");
  assert.equal(
    await page.getByText("No objects in this scene.", { exact: true }).isVisible(),
    true,
  );

  // Object parenting uses selection and drag/drop without a separate group form
  const nestedContext = await browser.newContext();
  try {
    const nested = await nestedContext.newPage();
    await nested.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
    await nested.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    await addAsset(nested, "Starter room");
    await addAsset(nested, "Sample crate");
    const parent = nested.locator("[data-object-id]").first();
    await parent.click();
    const labelX = await parent
      .locator("span")
      .evaluate((element) => element.getBoundingClientRect().x);
    await addAsset(nested, "Sample crate");
    assert.equal(
      await parent.locator("../..").locator("[data-object-id]").count(),
      1,
      "Selecting an ordinary object must not auto-nest new objects",
    );
    assert.equal(await nested.locator(".object-row").count(), 2);
    assert.equal(
      await parent.locator("span").evaluate((element) => element.getBoundingClientRect().x),
      labelX,
    );
    const sizes = await nested
      .locator(".object-row, .environment-row")
      .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).fontSize));
    assert.equal(new Set(sizes).size, 1, "All tree levels use the parent font size");
    await addAsset(nested, "Starter room");
    const roomInstance = nested.locator("[data-object-id]").filter({ hasText: "Starter room" });
    await roomInstance.click();
    await addAsset(nested, "Sample crate");
    // Placement follows the room under the pointer; explicit nesting remains a tree drop.
    await nested.locator("[data-object-id]").last().dragTo(roomInstance);
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
    assert.equal(await parent.locator("../..").locator("[data-object-id]").count(), 2);
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
    assert.match(await parent.textContent(), /Sample crate/);
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

  // Imported content is identified beneath its owner without inventing another viewport entity
  // Keyboard selection and disclosure must leave the authored document untouched
  const contentContext = await browser.newContext();
  try {
    const contentPage = await contentContext.newPage();
    await contentPage.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
    // Wait for startup recovery before bypassing the Open menu through its hidden file input
    await contentPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    const contentProject = structuredClone(fixture);
    contentProject.schemaVersion = 2;
    const scene = contentProject.scenes[0];
    Object.assign(scene, { groups: [], zones: [], viewpoints: [], rules: [] });
    for (const object of scene.objects) {
      Object.assign(object, { parentId: null, visible: true, components: [] });
    }
    const component = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      type: "hotspot",
      label: "Exhibit details",
    };
    scene.objects[0].components.push(component);
    await contentPage.locator("#project-import").setInputFiles({
      name: "content-tree.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(contentProject)),
    });
    await contentPage.getByText("Project opened", { exact: true }).waitFor();
    const contentRow = contentPage.locator(`[data-component-id="${component.id}"]`);
    await contentRow.waitFor();
    const owner = contentPage.locator(`[data-object-id="${scene.objects[0].id}"]`);
    assert.equal(await contentRow.getAttribute("data-owner-id"), scene.objects[0].id);
    await contentRow.focus();
    await contentPage.keyboard.press("Enter");
    assert.equal(await owner.getAttribute("aria-pressed"), "true");
    const before = await storedDocuments(contentPage);
    await contentPage.getByRole("button", { name: "Collapse First crate", exact: true }).click();
    assert.equal(await contentRow.isVisible(), false);
    assert.equal(await owner.getAttribute("aria-pressed"), "true");
    await contentPage
      .getByRole("button", { name: "Expand First crate", exact: true })
      .press("ArrowRight");
    assert.equal(await contentRow.isVisible(), true);
    assert.deepEqual(await storedDocuments(contentPage), before);
  } finally {
    await contentContext.close();
  }

  // Library browsing disables placement controls; close it before exercising hotspots.
  if (await page.locator(".asset-picker").count()) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
  const hotspot = page.getByRole("button", { name: "Add Hotspot", exact: true });
  assert.equal(await hotspot.isEnabled(), true);
  await hotspot.click();
  await page.getByText("Select an object to attach the hotspot to", { exact: true }).waitFor();
  assert.equal(await rows.count(), 0, "Hotspots need an object to attach to");

  await addAsset(page, "Sample crate");
  assert.equal(await rows.count(), 1);
  await hotspot.click();
  await page.getByText("Hotspot attached to the selected object", { exact: true }).waitFor();
  assert.equal(await rows.count(), 1, "Attaching a hotspot does not create a scene row");
  const hotspotIndicator = rows.first().locator(".hotspot-indicator");
  await hotspotIndicator.waitFor();
  assert.equal(await hotspotIndicator.getAttribute("title"), "Has hotspot");

  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  const interactionPanel = page.locator(".editor-panel").filter({ hasText: "Interactions" });
  await interactionPanel.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
  const hotspotTarget = interactionPanel.getByLabel("Interaction 1 hotspot", { exact: true });
  assert.equal(await hotspotTarget.locator("option").first().textContent(), "Sample crate");
  assert.match(
    await hotspotTarget.locator("option").first().getAttribute("value"),
    /^[a-f0-9-]{36}$/i,
  );
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();

  // Preview offers each click target as a keyboard control that runs the same rule
  const alerts = [];
  const recordAlert = (dialog) => alerts.push(dialog.message());
  page.on("dialog", recordAlert);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const previewTargets = page.getByRole("navigation", { name: "Interactive objects" });
  const crateTarget = previewTargets.getByRole("button", { name: "Sample crate", exact: true });
  await crateTarget.waitFor();
  await crateTarget.focus();
  await page.keyboard.press("Enter");
  for (let attempt = 0; attempt < 40 && alerts.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(alerts, ["hi"], "Keyboard activation runs the click interaction");
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  assert.equal(await previewTargets.count(), 0, "Editing hides the preview targets");
  page.off("dialog", recordAlert);

  const hotspotStage = await stage.boundingBox();
  const hotspotDock = await page.locator(".bottom-dock").boundingBox();
  assert.ok(hotspotStage);
  assert.ok(hotspotDock);
  const crateCentre = new THREE.Vector3(0, 0, 0).project(camera);
  await hotspot.dragTo(stage, {
    targetPosition: {
      x: ((crateCentre.x + 1) * hotspotStage.width) / 2,
      y: ((1 - crateCentre.y) * hotspotStage.height) / 2,
    },
  });
  await page
    .getByRole("alert")
    .filter({ hasText: "Each object can have at most one hotspot" })
    .waitFor();
  assert.equal(await rows.count(), 1, "Dropping a second hotspot does not add a row");
  assert.equal(await hotspotIndicator.getAttribute("title"), "Has hotspot");

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
  // Close browsing before retrying the background viewport
  await picker.getByRole("button", { name: "Close asset library" }).click();
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
    "PASS: placement, hotspot, preview keyboard activation, single-pointer movement, cancellation, hierarchy, room occlusion, project loading, undo/redo, keyboard, resizing, retry and WebGL fallback",
  );
} finally {
  await browser.close();
}
