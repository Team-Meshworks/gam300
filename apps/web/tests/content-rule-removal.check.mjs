import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5184/";
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.addInitScript(() => {
    window.showOpenFilePicker = undefined;
    window.showSaveFilePicker = undefined;
  });
  const project = await serveProject(page, origin);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await placeAtRoomCenter(page);
  await page.getByRole("button", { name: "Display panels", exact: true }).click();
  await page.getByRole("button", { name: "Landscape media stand", exact: true }).click();
  await placeAtRoomCenter(page);
  await page.locator(".object-row").first().click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("textbox", { name: "Text", exact: true }).fill("Referenced text");
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  async function saved() {
    await page.getByLabel("Project options", { exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('.save-state[data-state="saved"]').waitFor();
    const content = project.document();
    return content;
  }
  const withRules = await saved();
  const object = withRules.scenes[0].objects[0];
  const panelId = object.components[0].id;
  withRules.scenes[0].rules = [0, 1].map((index) => ({
    id: `0000019${index}-0000-4000-8000-000000000000`,
    enabled: true,
    trigger: { type: "panelClose", panelId },
    actions: [{ type: "openLink", url: "https://example.com/" }],
  }));
  project.setDocument(withRules);
  await page.goto(project.url);
  await openSavedProject(page);
  if ((await page.locator(`.object-row[data-object-id="${object.id}"]`).count()) === 0)
    await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.locator(`.object-row[data-object-id="${object.id}"]`).click();
  await page.getByRole("button", { name: "Remove text", exact: true }).click();
  const notice = await page.locator(".draft-feedback").innerText();
  const removed = await saved();
  assert.equal(removed.scenes[0].objects[0].components.length, 0);
  assert.equal(removed.scenes[0].rules.length, 0);
  assert.match(notice, /2 related rules.*Undo/i);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await saved(), withRules);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.deepEqual(await saved(), removed);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Edit image", exact: true }).click();
  await modal.getByRole("button", { name: "Sample landscape", exact: true }).click();
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  const replacementNotice = await page.locator(".draft-feedback").innerText();
  const replaced = await saved();
  assert.equal(replaced.scenes[0].objects[0].components[0].type, "image");
  assert.equal(replaced.scenes[0].rules.length, 0);
  assert.match(replacementNotice, /2 related rules.*Undo/i);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.deepEqual(await saved(), withRules);
  console.log(
    "PASS: removing referenced content reports affected rules and Undo/Redo restores both",
  );
} finally {
  await browser.close();
}
