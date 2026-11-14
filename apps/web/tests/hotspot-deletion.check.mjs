import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const hotspot = {
  id: "10000000-0000-4000-8000-000000000001",
  objectId: fixture.scenes[0].objects[0].id,
  position: [0, 1, 0],
};
const rule = {
  id: "10000000-0000-4000-8000-000000000002",
  enabled: true,
  trigger: { type: "click", targetId: hotspot.id },
  actions: [{ type: "openLink", url: "https://example.com" }],
};
const scene = {
  ...fixture.scenes[0],
  objects: fixture.scenes[0].objects.map((object) => ({
    ...object,
    parentId: null,
    visible: true,
    components: [],
  })),
  groups: [],
  zones: [],
  viewpoints: [],
  hotspots: [hotspot],
  interactions: [],
  rules: [rule],
};
const project = { ...fixture, schemaVersion: 2, scenes: [scene] };
const browser = await launchBrowser({ target: url, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage();
  const server = await serveProject(page, url, project);
  await page.goto(server.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator(".object-row[data-object-id]").first().click();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("button", { name: /^Remove hotspot from / }).click();
  const notice = await page.locator(".draft-feedback").textContent();
  assert.match(notice, /1 related rule\b/i, "Hotspot deletion reports the affected rule count");
  assert.match(notice, /undo restores/i, "Hotspot deletion explains how to restore the rule");
  let deadline = Date.now() + 15000;
  while (Date.now() < deadline && (server.document().scenes[0].hotspots?.length ?? 0))
    await page.waitForTimeout(100);
  assert.equal(server.document().scenes[0].rules?.length ?? 0, 0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  deadline = Date.now() + 15000;
  while (Date.now() < deadline && !server.document().scenes[0].hotspots?.length)
    await page.waitForTimeout(100);
  const restored = server.document().scenes[0];
  assert.deepEqual(restored.hotspots, [hotspot]);
  assert.deepEqual(restored.rules, [rule]);
  console.log("PASS: hotspot deletion reports related rules and Undo restores both");
} finally {
  await browser.close();
}
