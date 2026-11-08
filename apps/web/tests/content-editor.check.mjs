import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

mkdirSync("test-results/scrum56", { recursive: true });

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5184/",
  args: ["--enable-unsafe-swiftshader"],
});
const origin = process.argv[2] ?? "http://127.0.0.1:5184";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.displayVideos = [];
    const create = document.createElement.bind(document);
    document.createElement = function (tag, options) {
      const element = create(tag, options);
      if (tag === "video") window.displayVideos.push(element);
      return element;
    };
    window.showOpenFilePicker = undefined;
    window.showSaveFilePicker = undefined;
  });
  await page.goto(new URL("/editor.html", origin).href);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  // Dev now starts in first person; placement checks use the overview camera.
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  async function place(name) {
    if (name === "Starter room") {
      await page.getByRole("button", { name: "Rooms", exact: true }).click();
      await page.getByRole("button", { name: "Starter room", exact: true }).click();
    } else if (name === "Landscape media stand") {
      await page.getByRole("button", { name: "Display panels", exact: true }).click();
      await page.getByRole("button", { name, exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Asset library", exact: true }).click();
      await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
      await page.getByRole("button", { name: "Add", exact: true }).click();
    }
    await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  }
  async function saved() {
    await page.getByLabel("Project options", { exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const content = JSON.parse(readFileSync(await (await download).path(), "utf8"));
    // The download starts before the accompanying recovery write has completed.
    await page.waitForFunction(() => !document.querySelector("#project-save")?.disabled);
    return content;
  }
  await place("Starter room");
  const undoBeforePreview = await page
    .getByRole("button", { name: "Undo", exact: true })
    .isEnabled();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "Sample crate", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  assert.equal(
    await page.locator('.viewport-stage[data-placing-asset="test-crate-v1"]').count(),
    1,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".viewport-stage[data-placing-asset]").count(), 0);
  assert.equal(await page.locator(".object-row").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Undo", exact: true }).isEnabled(),
    undoBeforePreview,
    "Cancelled placement must not create a history entry",
  );
  await place("Landscape media stand");
  async function openText() {
    if (
      (await page
        .getByRole("button", { name: "Edit exhibit information", exact: true })
        .count()) === 0
    )
      await page.getByRole("button", { name: "Position", exact: true }).click();
    await page.getByRole("button", { name: "Edit exhibit information", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Text", exact: true }).click();
  }
  const renderer = await page.locator(".viewport-stage canvas").elementHandle();
  const initial = await saved();
  const id = initial.scenes[0].objects[0].id;

  // Cancel must not upgrade the format or change the live document
  await openText();
  const modal = page.getByRole("dialog");
  await modal.getByRole("textbox", { name: "Text", exact: true }).fill("Discard this");
  await modal.getByRole("button", { name: "Cancel content editing", exact: true }).click();
  assert.deepEqual(await saved(), initial);
  assert.equal(
    await renderer.evaluate((canvas) => canvas.isConnected),
    true,
    "Content selection must retain the running viewport",
  );

  // Formatting stays literal and the media empty state cannot add a broken placeholder
  await openText();
  const text = modal.getByRole("textbox", { name: "Text", exact: true });
  const story = "Hello <script>🏺</script>";
  await text.fill(story);
  await text.evaluate((input) => {
    const node = document.createTreeWalker(input, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await text.press("Control+b");
  assert.equal(await text.locator("strong").innerText(), "Hello");
  for (const [shortcut, tag] of [
    ["Control+i", "em"],
    ["Control+u", "u"],
    ["Meta+i", "em"],
  ]) {
    await text.press(shortcut);
    assert.equal(await text.locator(tag).innerText(), "Hello");
    await text.press(shortcut);
    assert.equal(await text.locator(tag).count(), 0);
  }
  await modal.getByRole("button", { name: "Clear text formatting", exact: true }).hover();
  assert.equal(
    await modal.getByRole("tooltip", { name: "Clear Formatting", exact: true }).isVisible(),
    true,
  );
  assert.equal(await modal.getByRole("button", { name: "Audio", exact: true }).count(), 0);
  assert.equal(await modal.getByRole("button", { name: "Hotspot", exact: true }).count(), 0);
  assert.equal(await modal.getByRole("button", { name: "Properties", exact: true }).count(), 0);
  assert.equal(await modal.getByRole("button", { name: "Image", exact: true }).count(), 1);
  assert.equal(await modal.getByRole("button", { name: "Video", exact: true }).count(), 1);
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  const after = await saved();
  const object = after.scenes[0].objects.find((entry) => entry.id === id);
  const content = object.components[0];
  assert.equal(after.schemaVersion, 2);
  assert.equal(object.components.length, 1);
  assert.equal(content.runs.map((run) => run.text).join(""), story);
  assert.deepEqual(content.runs[0].marks, ["bold"]);

  // One undo removes the whole content edit; redo restores the exact target ID
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const undone = await saved();
  assert.equal(undone.scenes[0].objects[0].components.length, 0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.deepEqual(await saved(), after);

  // Imported content reopens through the real file reader with stable IDs and mixed formatting
  await page.locator("#project-import").setInputFiles({
    name: "content.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(after)),
  });
  // Download fallback does not claim a bound file save; explicitly approve replacing this draft
  await page
    .locator(".project-confirmation")
    .getByRole("button", { name: "Don’t Save", exact: true })
    .click();
  await page.locator(".project-confirmation").waitFor({ state: "hidden" });
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.locator(`.object-row[data-object-id="${id}"]`).click();
  await openText();
  assert.equal(await modal.getByRole("textbox", { name: "Text", exact: true }).innerText(), story);
  await modal.screenshot({ path: "test-results/scrum56/text-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await modal.screenshot({ path: "test-results/scrum56/text-mobile.png" });
  await modal.getByRole("button", { name: "Cancel content editing", exact: true }).click();
  // Digital displays accept text and media; physical cases expose neither text nor media.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByRole("button", { name: "Display panels", exact: true }).click();
  await page.getByRole("button", { name: "Square media stand", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  if (
    (await page.getByRole("button", { name: "Edit exhibit information", exact: true }).count()) ===
    0
  )
    await page.getByRole("button", { name: "Position", exact: true }).click();
  await page.getByRole("button", { name: "Edit exhibit information", exact: true }).click();
  await modal.getByRole("button", { name: "Text", exact: true }).click();
  await modal.getByRole("textbox", { name: "Text", exact: true }).fill("Digital display text");
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Edit exhibit information", exact: true }).click();
  await modal.getByRole("button", { name: "Image", exact: true }).click();
  await modal.getByRole("button", { name: "Sample landscape", exact: true }).click();
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Edit exhibit information", exact: true }).click();
  await modal.getByRole("button", { name: "Video", exact: true }).click();
  await modal.getByRole("button", { name: "Sample coast motion (3 seconds)", exact: true }).click();
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Display cases", exact: true }).click();
  await page.getByRole("button", { name: "Display plinth", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 600, y: 300 } });
  assert.equal(
    await page.getByRole("button", { name: "Edit exhibit information", exact: true }).isEnabled(),
    true,
  );
  const fixtureSave = await saved();
  assert.equal(fixtureSave.scenes[0].objects.length, 3);
  const displayMedia = fixtureSave.scenes[0].objects.find(
    (object) => object.assetId === "display-square-stand-v1",
  ).components;
  assert.equal(displayMedia[0].assetId, "sample-coast-video-v1");
  await page.waitForFunction(() =>
    window.displayVideos.some(
      (video) => video.src.length > 0 && !video.paused && video.muted && video.currentTime > 0.15,
    ),
  );
  assert.equal(displayMedia.length, 1);
  assert.equal(
    fixtureSave.scenes[0].objects.find((object) => object.assetId === "display-cube-v1").components
      .length,
    0,
  );
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const testCase = fixtureSave.scenes[0].objects.find(
    (object) => object.assetId === "display-cube-v1",
  );
  await page.locator(`.object-row[data-object-id="${testCase.id}"]`).click();
  await page.getByRole("button", { name: "Display colour", exact: true }).hover();
  assert.equal(await page.getByRole("tooltip", { name: "Colour", exact: true }).isVisible(), true);
  await page.getByRole("button", { name: "Display colour", exact: true }).click();
  await page.getByRole("button", { name: "Colour #bd2949", exact: true }).click();
  await page.keyboard.press("Escape");
  const coloured = await saved();
  assert.equal(
    coloured.scenes[0].objects.find((object) => object.id === testCase.id).appearance.color,
    "#bd2949",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await saved(), fixtureSave);
  await page.getByRole("button", { name: "Display texture", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog", { name: "Display texture", exact: true })
      .getByRole("button")
      .count(),
    8,
  );
  await page.getByRole("button", { name: "wood texture", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Display texture", exact: true })
    .screenshot({ path: "test-results/scrum56/texture-popup.png" });
  await page.keyboard.press("Escape");
  const styled = await saved();
  assert.equal(
    styled.scenes[0].objects.find((object) => object.id === testCase.id).appearance.material,
    "wood",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await saved(), fixtureSave);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.deepEqual(await saved(), styled);
  // Dragging uses the same translucent asset preview and only dropping commits an object.
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const draggedCard = await page
    .locator(".asset-picker")
    .getByRole("button", { name: "Sample crate", exact: true })
    .elementHandle();
  const dragData = await page.evaluateHandle(() => new DataTransfer());
  await draggedCard.dispatchEvent("dragstart", { dataTransfer: dragData });
  const stage = page.locator(".viewport-stage");
  assert.equal(await stage.getAttribute("data-dragging-asset"), "test-crate-v1");
  assert.equal(await page.locator(".asset-picker").isVisible(), false);
  assert.equal(await page.locator(".object-row").count(), 3);
  const bounds = await stage.boundingBox();
  const drop = {
    dataTransfer: dragData,
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
  };
  await stage.dispatchEvent("dragover", drop);
  await page.screenshot({ path: "test-results/scrum56/drag-preview.png" });
  await stage.dispatchEvent("dragleave", { dataTransfer: dragData });
  await draggedCard.dispatchEvent("dragend", { dataTransfer: dragData });
  assert.equal(await stage.getAttribute("data-dragging-asset"), null);
  assert.equal(await page.locator(".object-row").count(), 3);
  const secondData = await page.evaluateHandle(() => new DataTransfer());
  await draggedCard.dispatchEvent("dragstart", { dataTransfer: secondData });
  const confirmedDrop = { ...drop, dataTransfer: secondData };
  await stage.dispatchEvent("dragover", confirmedDrop);
  await stage.dispatchEvent("drop", confirmedDrop);
  await draggedCard.dispatchEvent("dragend", { dataTransfer: secondData });
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 4);
  assert.equal(await stage.getAttribute("data-dragging-asset"), null);
  // Synthetic dragend lacks the native accepted drop effect; dismiss the retained picker.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: content Cancel, literal formatting, display media gating, single Undo/Redo, appearance, drag placement and save/reopen",
  );
} finally {
  await browser.close();
}
