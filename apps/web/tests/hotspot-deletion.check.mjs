import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const url = new URL("/editor.html", process.argv[2] ?? "http://127.0.0.1:5173/").href;
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
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator("#project-import").setInputFiles({
    name: "hotspot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByText("Project opened", { exact: true }).waitFor();
  await page.locator(".object-row[data-object-id]").first().click();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("button", { name: /^Remove hotspot from / }).click();
  const notice = await page.locator(".draft-feedback").textContent();
  assert.match(notice, /1 related rule\b/i, "Hotspot deletion reports the affected rule count");
  assert.match(notice, /undo restores/i, "Hotspot deletion explains how to restore the rule");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const restored = await page.evaluate(async () => {
    const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const result = await loadRecoverySession(
      new Map(assets.map((asset) => [asset.id, asset.kind])),
    );
    return result.value?.document.scenes[0];
  });
  assert.deepEqual(restored.hotspots, [hotspot]);
  assert.deepEqual(restored.rules, [rule]);
  console.log("PASS: hotspot deletion reports related rules and Undo restores both");
} finally {
  await browser.close();
}
