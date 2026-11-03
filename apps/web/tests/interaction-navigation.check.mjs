import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pose = (x, fovDegrees = 45) => ({ position: [x, 4, 8], rotation: [0, 0, 0, 1], fovDegrees });
const object = (n, name) => ({
  ...fixture.scenes[0].objects[0],
  id: id(n),
  name,
  parentId: null,
  visible: true,
  components: [],
});
const hotspot = (n, objectId) => ({ id: id(n), objectId, position: [0, 1, 0] });
const click = (n, action) => ({
  when: { type: "visitor-clicks-hotspot", targetHotspotId: id(n) },
  do: action,
});
const first = {
  ...fixture.scenes[0],
  id: id(1),
  name: "Gallery",
  startCamera: pose(0, 60),
  objects: [object(10, "Next room"), object(11, "Detail view")],
  groups: [],
  zones: [],
  rules: [],
  viewpoints: [
    {
      id: id(20),
      name: "Detail",
      camera: { ...pose(10), rotation: [0, 0.6, 0, 0.8] },
    },
    { id: id(21), name: "Detail", camera: pose(-5) },
  ],
  hotspots: [hotspot(30, id(10)), hotspot(31, id(11))],
  interactions: [click(30, { type: "print-hi" }), click(31, { type: "print-hi" })],
};
const second = {
  ...first,
  id: id(2),
  startCamera: pose(20, 70),
  objects: [object(12, "Back to first")],
  viewpoints: [],
  hotspots: [hotspot(32, id(12))],
  interactions: [
    { when: { type: "scene-starts" }, do: { type: "print-hi" } },
    click(32, { type: "navigate-scene", sceneId: id(1) }),
  ],
};
const project = { ...fixture, schemaVersion: 2, scenes: [first, second] };
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const alerts = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "alert") alerts.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.locator("#project-import").setInputFiles({
    name: "navigation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByText("Project opened", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByLabel("Interaction 1 do", { exact: true }).selectOption("navigate-scene");
  assert.equal(
    await page.getByLabel("Interaction 1 destination scene", { exact: true }).inputValue(),
    second.id,
  );
  assert.deepEqual(
    await page
      .getByLabel("Interaction 1 destination scene", { exact: true })
      .locator("option")
      .allTextContents(),
    ["1. Gallery", "2. Gallery"],
  );
  await page.getByLabel("Interaction 2 do", { exact: true }).selectOption("move-to-viewpoint");
  const destination = page.getByLabel("Interaction 2 destination viewpoint", { exact: true });
  assert.deepEqual(await destination.locator("option").allTextContents(), [
    "1. Detail",
    "2. Detail",
  ]);
  await destination.selectOption(id(21));
  await destination.blur();
  await page.keyboard.press("Control+z");
  assert.equal(await destination.inputValue(), id(20));
  await page.keyboard.press("Control+y");
  assert.equal(await destination.inputValue(), id(21));
  // Wait for the real session backup, then verify selected IDs survive reload.
  let backedUp = false;
  for (let attempt = 0; attempt < 100 && !backedUp; attempt++) {
    backedUp = await page.evaluate(async (viewId) => {
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const result = await loadRecoverySession(
        new Map(assets.map((asset) => [asset.id, asset.kind])),
      );
      return (
        result.ok && result.value?.document?.scenes[0]?.interactions[1]?.do.viewpointId === viewId
      );
    }, id(21));
    if (!backedUp) await page.waitForTimeout(100);
  }
  assert.equal(backedUp, true, "Navigation choices reach browser recovery before reload");
  await page.reload();
  await page.getByText("Reopened your last project", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  assert.equal(
    await page.getByLabel("Interaction 2 destination viewpoint", { exact: true }).inputValue(),
    id(21),
  );
  // Observe rendered camera poses without replacing the production action or renderer.
  await page.evaluate(async () => {
    const source = await (await fetch("/graphics/scene.ts")).text();
    const threePath = source.match(/import \* as THREE from "([^"]+)"/)[1];
    const THREE = await import(threePath);
    const update = THREE.PerspectiveCamera.prototype.updateMatrixWorld;
    THREE.PerspectiveCamera.prototype.updateMatrixWorld = function (...args) {
      window.navigationCamera = {
        position: this.position.toArray(),
        rotation: this.quaternion.toArray(),
        fov: this.fov,
      };
      return update.apply(this, args);
    };
  });
  // Frame A differently from its starting view before entering preview.
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "Next saved view", exact: true }).click();
  await page.waitForFunction(
    () => window.navigationCamera?.position[0] === 10 && window.navigationCamera?.fov === 45,
  );
  await page.waitForTimeout(350);
  const editingCamera = await page.evaluate(() => window.navigationCamera);
  assert.notDeepEqual(editingCamera.position, first.startCamera.position);
  assert.notDeepEqual(editingCamera.rotation, first.startCamera.rotation);
  assert.notEqual(editingCamera.fov, first.startCamera.fovDegrees);
  const assertEditingCamera = async () => {
    // Let the origin-scene React effect and subsequent controls/render frames finish.
    await page.waitForTimeout(350);
    const restored = await page.evaluate(() => window.navigationCamera);
    for (const field of ["position", "rotation"]) {
      restored[field].forEach((value, index) =>
        assert.ok(
          Math.abs(value - editingCamera[field][index]) < 1e-6,
          `Editing camera ${field}[${index}]: expected ${editingCamera[field][index]}, got ${value}`,
        ),
      );
    }
    assert.equal(restored.fov, editingCamera.fov, "Restore the editing field of view");
  };
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const targets = page.getByRole("navigation", { name: "Interactive objects" });
  await targets.getByRole("button", { name: "Detail view", exact: true }).click();
  await page
    .waitForFunction(
      () => window.navigationCamera?.position[0] === -5 && window.navigationCamera?.fov === 45,
      null,
      { timeout: 5000 },
    )
    .catch(async () => {
      throw new Error(
        JSON.stringify({
          camera: await page.evaluate(() => window.navigationCamera),
          body: await page.locator("body").innerText(),
          errors,
        }),
      );
    });
  await page.waitForTimeout(350);
  assert.deepEqual(
    (await page.evaluate(() => window.navigationCamera)).position,
    pose(-5).position,
    "Visitor physics must retain the selected view",
  );
  const canvas = await page.locator(".viewport-stage canvas").elementHandle();
  await targets.getByRole("button", { name: "Next room", exact: true }).click();
  await targets.getByRole("button", { name: "Back to first", exact: true }).waitFor();
  await page.waitForFunction(
    () => window.navigationCamera?.position[0] === 20 && window.navigationCamera?.fov === 70,
  );
  assert.equal(await page.locator(".editor-shell.is-previewing").count(), 1);
  assert.equal(
    await canvas.evaluate((element) => element.isConnected),
    true,
    "Scene changes retain the viewport",
  );
  assert.deepEqual(alerts, ["hi"], "Destination scene-start fires exactly once");
  await targets.getByRole("button", { name: "Back to first", exact: true }).click();
  await targets.getByRole("button", { name: "Next room", exact: true }).waitFor();
  await targets.getByRole("button", { name: "Next room", exact: true }).click();
  await targets.getByRole("button", { name: "Back to first", exact: true }).waitFor();
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.locator(".object-row").filter({ hasText: "Detail view" }).waitFor();
  assert.equal(await page.locator(".editor-shell.is-previewing").count(), 0);
  await assertEditingCamera();
  // A second preview that stays in A also retains the editing camera.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await targets.getByRole("button", { name: "Detail view", exact: true }).click();
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await assertEditingCamera();
  // Restoration must not suppress the next ordinary editor scene change.
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByRole("button", { name: "2. Gallery", exact: true }).click();
  await page.waitForFunction(
    () => window.navigationCamera?.position[0] === 20 && window.navigationCamera?.fov === 70,
  );
  await page.getByRole("button", { name: "1. Gallery", exact: true }).click();
  await page.waitForFunction(
    () => window.navigationCamera?.position[0] === 0 && window.navigationCamera?.fov === 60,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: destination controls, undo/redo, reload, rendered viewpoint persistence, scene-start, scene return, editing camera restoration and normal editor navigation",
  );
  await context.close();

  for (const trigger of ["scene-starts", "time-elapsed"]) {
    const chainContext = await browser.newContext();
    const chainPage = await chainContext.newPage();
    const chainErrors = [];
    chainPage.on("pageerror", (error) => chainErrors.push(error.message));
    const chain = structuredClone(project);
    chain.scenes[0].interactions = [
      {
        when: trigger === "scene-starts" ? { type: trigger } : { type: trigger, seconds: 0.25 },
        do: { type: "navigate-scene", sceneId: second.id },
      },
    ];
    chain.scenes[1].interactions = [
      { when: { type: "scene-starts" }, do: { type: "navigate-scene", sceneId: first.id } },
    ];
    await chainPage.goto(url);
    await chainPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    await chainPage.locator("#project-import").setInputFiles({
      name: "chain.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(chain)),
    });
    await chainPage.getByText("Project opened", { exact: true }).waitFor();
    await chainPage.getByRole("button", { name: "Preview", exact: true }).click();
    await chainPage
      .getByRole("status")
      .filter({ hasText: "Navigation stopped: scene-start interactions form a loop." })
      .waitFor();
    assert.equal(await chainPage.locator(".editor-shell.is-previewing").count(), 1);
    await chainPage.getByRole("button", { name: "Exit preview", exact: true }).click();
    await chainPage.locator(".object-row").filter({ hasText: "Detail view" }).waitFor();
    assert.deepEqual(chainErrors, []);
    await chainContext.close();
  }
  console.log(
    "PASS: scene-start and timed navigation preserve preview; cyclic scene-start rules stop safely",
  );
} finally {
  await browser.close();
}
