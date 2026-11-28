import { sceneNameInput } from "./authoring-project-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const first = {
  ...fixture.scenes[0],
  id: id(1),
  name: "First room",
  objects: [
    { ...fixture.scenes[0].objects[0], id: id(10), parentId: null, visible: true, components: [] },
  ],
  groups: [],
  zones: [],
  rules: [],
  viewpoints: [],
  hotspots: [{ id: id(20), objectId: id(10), position: [0, 1, 0] }],
  interactions: [
    { when: { type: "visitor-clicks-hotspot", targetHotspotId: id(20) }, do: { type: "print-hi" } },
  ],
};
const browser = await launchBrowser({ target: url, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, url, { ...fixture, schemaVersion: 2, scenes: [first] });
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "1. Default View", exact: true }).dblclick();
  await page.getByLabel("View name", { exact: true }).fill("First arrival");
  await page.getByLabel("View name", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "1. First arrival", exact: true }).waitFor();
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await (await sceneNameInput(page)).fill("Cancelled scene rename");
  await (await sceneNameInput(page)).press("Escape");
  await page.getByRole("button", { name: "1. First room", exact: true }).waitFor();
  await page.getByRole("button", { name: "+ Add Scene", exact: true }).click();
  const addedScene = page.getByRole("button", { name: "2. Scene 2", exact: true });
  await addedScene.waitFor();
  assert.equal(await addedScene.getAttribute("aria-pressed"), "true");
  assert.equal(
    await addedScene.locator("..").getAttribute("data-selected"),
    "false",
    "Adding a scene does not select its row",
  );
  await addedScene.click();
  assert.equal(
    await addedScene.locator("..").getAttribute("data-selected"),
    "true",
    "Clicking a scene selects its row",
  );
  await (await sceneNameInput(page)).fill(" ");
  await (await sceneNameInput(page)).press("Enter");
  await page
    .getByText("Enter a scene name between 1 and 120 characters", { exact: true })
    .waitFor();
  await (await sceneNameInput(page)).fill("Second room");
  await (await sceneNameInput(page)).press("Enter");
  await page.getByRole("button", { name: "2. Second room", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Reorder scene Second room", exact: true })
    .press("ArrowUp");
  await page.getByRole("button", { name: "1. Second room", exact: true }).waitFor();
  const reorderTarget = page.locator(".scene-list-panel .saved-view-card").nth(1);
  const reorderBounds = await reorderTarget.boundingBox();
  await page
    .getByRole("button", { name: "Reorder scene Second room", exact: true })
    .dragTo(reorderTarget, {
      targetPosition: { x: reorderBounds.width / 2, y: reorderBounds.height - 4 },
    });
  await page.getByRole("button", { name: "2. Second room", exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "1. Second room", exact: true }).waitFor();
  if (process.env.SPATIA_SCENES_SCREENSHOT)
    await page.locator(".scenes-shell").screenshot({ path: process.env.SPATIA_SCENES_SCREENSHOT });
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "1. Default View", exact: true }).dblclick();
  await page.getByLabel("View name", { exact: true }).fill("Second arrival");
  await page.getByLabel("View name", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "1. Second arrival", exact: true }).waitFor();
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "2. First room", exact: true }).click();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByLabel("Interaction 1 do", { exact: true }).selectOption("navigate-scene");
  const target = await page
    .getByLabel("Interaction 1 destination scene", { exact: true })
    .inputValue();
  assert.notEqual(target, first.id);
  await page.getByLabel("Interaction 1 destination scene", { exact: true }).blur();
  const saved = await project.waitForDocument(
    (doc) => doc.scenes[1]?.interactions?.[0]?.do.sceneId === target,
  );
  assert.deepEqual(
    saved.scenes.map((scene) => scene.name),
    ["Second room", "First room"],
  );
  assert.equal(saved.scenes[0].id, target);
  assert.equal(saved.scenes[0].viewpoints[0].name, "Second arrival");
  assert.deepEqual(saved.scenes[0].startCamera, saved.scenes[0].viewpoints[0].camera);
  assert.equal(saved.scenes[1].viewpoints[0].name, "First arrival");
  assert.deepEqual(saved.scenes[1].startCamera, saved.scenes[1].viewpoints[0].camera);
  assert.equal(saved.scenes[1].interactions[0].do.sceneId, target);
  await page.reload();
  await openSavedProject(page);
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "1. Second room", exact: true }).click();
  await page.getByRole("button", { name: "2. First room", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Undo", exact: true }).isEnabled(),
    false,
    "Switching scenes does not add history",
  );
  await page.getByRole("button", { name: "1. Second room", exact: true }).click();
  await page
    .locator('.scene-name[aria-pressed="true"]')
    .locator("..")
    .getByRole("button", { name: /^Delete scene / })
    .click();
  await page.getByRole("button", { name: "Confirm delete scene", exact: true }).click();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  assert.equal(
    await page.getByLabel("Interaction 1 do", { exact: true }).count(),
    0,
    "Incoming rule is removed",
  );
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "2. First room", exact: true }).click();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  assert.equal(
    await page.getByLabel("Interaction 1 destination scene", { exact: true }).inputValue(),
    target,
    "Undo restores incoming target",
  );
  console.log(
    "PASS: scene creation, keyboard reorder, starting view, server round trip, switching history and referenced deletion undo",
  );
} finally {
  await browser.close();
}
