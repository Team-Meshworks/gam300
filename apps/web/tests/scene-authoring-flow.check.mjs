import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const url = new URL("/editor.html", process.argv[2] ?? "http://127.0.0.1:5173/").href;
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
  let page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.addInitScript(() => {
    window.showSaveFilePicker = undefined;
    window.showOpenFilePicker = undefined;
  });
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator("#project-import").setInputFiles({
    name: "start.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...fixture, schemaVersion: 2, scenes: [first] })),
  });
  await page.getByText("Project opened", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByLabel("View name", { exact: true }).fill("First arrival");
  await page.getByRole("button", { name: "Capture current view", exact: true }).click();
  await page.getByText("Starting view: First arrival", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByLabel("Scene name", { exact: true }).fill("Second room");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("button", { name: "2. Second room", exact: true }).waitFor();
  await page.getByRole("button", { name: "Move scene up", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "1. Second room", exact: true }).waitFor();
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByLabel("View name", { exact: true }).fill("Second arrival");
  await page.getByRole("button", { name: "Capture current view", exact: true }).click();
  await page.getByText("Starting view: Second arrival", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "2. First room", exact: true }).click();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByLabel("Interaction 1 do", { exact: true }).selectOption("navigate-scene");
  const target = await page
    .getByLabel("Interaction 1 destination scene", { exact: true })
    .inputValue();
  assert.notEqual(target, first.id);
  await page.getByLabel("Interaction 1 destination scene", { exact: true }).blur();
  await page.locator(".draft-menu summary").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save As", exact: true }).click();
  const saved = JSON.parse(readFileSync(await (await downloading).path(), "utf8"));
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
  await page.close();
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator("#project-import").setInputFiles({
    name: "saved.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page.getByText("Project opened", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "1. Second room", exact: true }).click();
  await page.getByRole("button", { name: "2. First room", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Undo", exact: true }).isEnabled(),
    false,
    "Switching scenes does not add history",
  );
  await page.getByRole("button", { name: "1. Second room", exact: true }).click();
  await page.getByRole("button", { name: "Delete scene", exact: true }).click();
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
    "PASS: scene creation, keyboard reorder, starting view, file round trip, switching history and referenced deletion undo",
  );
} finally {
  await browser.close();
}
