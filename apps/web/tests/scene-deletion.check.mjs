import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const first = {
  ...fixture.scenes[0],
  name: "First room",
  objects: fixture.scenes[0].objects.map((object) => ({
    ...object,
    parentId: null,
    visible: true,
    components: [],
  })),
  groups: [],
  zones: [],
  rules: [],
  viewpoints: [],
  hotspots: [],
  interactions: [],
};
const second = {
  ...first,
  id: "10000000-0000-4000-8000-000000000002",
  name: "Second room",
  objects: [],
  groups: [],
  zones: [],
  rules: [],
};
const project = { ...fixture, schemaVersion: 2, scenes: [first, second] };
const browser = await launchBrowser({ target: url, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator("#project-import").setInputFiles({
    name: "scenes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByText("Project opened", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "Delete scene", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm scene deletion" });
  const impact = await confirmation.innerText();
  assert.match(impact, /First room/);
  assert.match(impact, /2 objects and 0 saved views/);
  assert.match(
    impact,
    /Navigation links to this scene and their associated rules will also be deleted/,
  );
  assert.match(impact, /Undo restores everything/);
  await page.getByRole("button", { name: "2. Second room", exact: true }).click();
  assert.equal(
    await confirmation.count(),
    0,
    "Switching scenes must close the pending deletion confirmation",
  );
  console.log("PASS: scene deletion confirmation reports impact and closes when switching scenes");
} finally {
  await browser.close();
}
