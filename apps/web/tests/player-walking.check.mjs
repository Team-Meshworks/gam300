import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { blankProject, serveProject } from "./authoring-project-fixture.mjs";

const id = "11111111-1111-4111-8111-111111111112";
const moduleId = "11111111-1111-4111-8111-111111111113";
const caseId = "11111111-1111-4111-8111-111111111114";
const pub = "11111111-1111-4111-8111-111111111111";
const bytes = readFileSync(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const caseBytes = readFileSync(
  new URL(
    "../../../assets/delivery/stands-displays/display-full-glass-case-v1.glb",
    import.meta.url,
  ),
);
const models = [
  { id, name: "Room", kind: "environment", sha256 },
  { id: moduleId, name: "Room module", kind: "model", sha256 },
  {
    id: caseId,
    name: "Glass case",
    kind: "model",
    sha256: createHash("sha256").update(caseBytes).digest("hex"),
  },
];
const assetRows = (basePath) =>
  models.map((model) => ({
    ...model,
    url: basePath + "/" + model.id + "/bytes",
    category: null,
    thumbnail: null,
  }));
const assetResponse = (path) => ({
  contentType: "model/gltf-binary",
  body: path.endsWith("/" + caseId + "/bytes") ? caseBytes : bytes,
});
const base = blankProject.scenes[0];
const scene = (name, objects) => ({
  ...structuredClone(base),
  name,
  environmentAssetId: id,
  startCamera: {
    position: [0, 0.9, 0],
    rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
    fovDegrees: 40,
  },
  objects,
});
const room = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Adjacent room",
  assetId: moduleId,
  transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  parentId: null,
  visible: true,
  components: [],
};
const display = {
  ...room,
  id: "55555555-5555-4555-8555-555555555556",
  name: "Glass case",
  assetId: caseId,
  transform: { position: [8, 0.2, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] },
};
const roomPanel = {
  id: "55555555-5555-4555-8555-555555555558",
  type: "text",
  runs: [{ text: "Room information", marks: [] }],
  caption: "",
};
const showRoomPanel = { type: "showPanel", panelId: roomPanel.id };
const returnToStart = {
  id: "55555555-5555-4555-8555-555555555561",
  type: "navigationPoint",
  label: "Return to open floor",
  sceneId: base.id,
  viewpointId: "55555555-5555-4555-8555-555555555562",
};
const doorway = scene("Doorway", [{ ...room, components: [roomPanel, returnToStart] }, display]);
doorway.viewpoints = [
  { id: returnToStart.viewpointId, name: "Open floor", camera: doorway.startCamera },
];
doorway.rules = [
  {
    id: "55555555-5555-4555-8555-555555555557",
    enabled: true,
    trigger: { type: "click", targetId: display.id },
    actions: [{ type: "setVisible", objectId: display.id, visible: false }],
  },
  {
    id: "55555555-5555-4555-8555-555555555559",
    enabled: true,
    trigger: { type: "sceneStart" },
    actions: [showRoomPanel],
  },
  {
    id: "55555555-5555-4555-8555-555555555560",
    enabled: true,
    trigger: { type: "click", targetId: room.id },
    actions: [showRoomPanel],
  },
];
const project = { ...blankProject, scenes: [doorway] };

async function assertStoppedOnOpenFloor(page, label) {
  const releasedAt = await page.evaluate(() => window.walkCamera.position.x);
  assert.ok(releasedAt < 5.5, `${label}: released outside open floor at x=${releasedAt}`);
  await page.clock.resume();
  const positions = await page.evaluate(async () => {
    const samples = [];
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(requestAnimationFrame);
      samples.push(window.walkCamera.position.x);
    }
    return samples;
  });
  for (const x of positions)
    assert.ok(Math.abs(x - releasedAt) < 1e-5, `${label}: drift from ${releasedAt} to ${x}`);
}

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const observe = async (page) => {
    await page.clock.install();
    await page.addInitScript(() => {
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
        const renderer = event.detail;
        if (!renderer.isWebGLRenderer) return;
        const render = renderer.render;
        renderer.render = function (scene, camera) {
          if (["3D scene", "Exhibition view"].includes(this.domElement.getAttribute("aria-label")))
            window.walkCamera = camera;
          return render.call(this, scene, camera);
        };
      });
    });
  };
  const editor = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await observe(editor);
  const saved = await serveProject(editor, origin, project);
  const projectAssets = `/api/v1/projects/${project.projectId}/assets`;
  await editor.route(`**${projectAssets}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return path === projectAssets
      ? route.fulfill({ json: assetRows(projectAssets) })
      : route.fulfill(assetResponse(path));
  });
  await editor.goto(saved.url);
  await editor
    .getByRole("status")
    .filter({ hasText: "Scene ready" })
    .waitFor({ timeout: 10000 })
    .catch(async (e) => {
      throw new Error(e.message + "\n" + (await editor.locator("body").innerText()));
    });
  async function walkInEditor(caseX) {
    await editor.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    assert.equal(
      await editor
        .getByRole("button", { name: "Third person", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    await editor.locator('canvas[aria-label="3D scene"]').click();
    async function walk(key, threshold) {
      await editor.keyboard.down(key);
      try {
        await editor.waitForFunction(
          ([key, threshold]) =>
            key === "s"
              ? window.walkCamera.position.x < threshold
              : window.walkCamera.position.x > threshold,
          [key, threshold],
        );
        // Keep pushing against the obstacle after reaching its near face.
        await editor.evaluate(async () => {
          for (let i = 0; i < 40; i++) await new Promise(requestAnimationFrame);
        });
        return await editor.evaluate(() => window.walkCamera.position.x);
      } finally {
        await editor.keyboard.up(key);
      }
    }
    const wall = await walk("s", -4.54);
    const prop = await walk("w", caseX - 0.86);
    await editor.evaluate(() => document.exitPointerLock());
    return { wall, prop, caseX };
  }
  const beforePreview = await walkInEditor(8);
  await editor.getByRole("button", { name: "Preview", exact: true }).click();
  const visitor = await browser.newPage();
  await observe(visitor);
  await visitor.route("**/api/v1/publications/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/bytes")) return route.fulfill(assetResponse(path));
    return route.fulfill({
      json: path.endsWith("/manifest")
        ? {
            publicationId: pub,
            projectId: project.projectId,
            sourceRevision: 1,
            assets: assetRows(`/api/v1/publications/${pub}/assets`),
          }
        : project,
    });
  });
  await visitor.goto(`${origin}/p/${pub}`);
  const outcomes = [];
  for (const [name, page] of [
    ["preview", editor],
    ["visitor", visitor],
  ]) {
    await page.bringToFront();
    await page.getByRole("status").getByText("Exhibition ready").waitFor();
    await page.waitForFunction(() => !!window.walkCamera);
    const canvas = page.getByLabel("Exhibition view", { exact: true });
    const content = page.locator("[data-exhibition-scene]");
    const activateRoom = () =>
      content.evaluate(
        (node, id) => node.dispatchEvent(new CustomEvent("exhibit-activate", { detail: id })),
        room.id,
      );
    async function startReleaseProbe(key) {
      await content.getByRole("button", { name: returnToStart.label }).click();
      await page.waitForFunction(() => Math.abs(window.walkCamera.position.x) < 1e-5);
      await canvas.focus();
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 10000);
      await page.keyboard.down(key);
      await page.clock.runFor(160);
      const x = await page.evaluate(() => window.walkCamera.position.x);
      assert.ok(x > 0.2 && x < 0.65, `${name} ${key}: expected a short walk from x=0, got ${x}`);
    }
    await content.getByRole("button", { name: "Close panel" }).click();
    await startReleaseProbe("w");
    await activateRoom();
    assert.ok(await content.getByText("Room information", { exact: true }).isVisible());
    const summary = page.getByText("Exhibit information", { exact: true });
    assert.ok(await summary.evaluate((node) => document.activeElement === node));
    await summary.evaluate((node) =>
      node.addEventListener("keyup", (event) => event.stopPropagation(), { once: true }),
    );
    await page.keyboard.up("w");
    await canvas.focus();
    await assertStoppedOnOpenFloor(page, `${name} after opening the panel`);

    for (const key of ["w", "ArrowUp"]) {
      await startReleaseProbe(key);
      await canvas.evaluate((node) => {
        node.addEventListener(
          "keyup",
          (event) => {
            event.stopPropagation();
            node.dataset.stoppedKey = event.key;
          },
          { once: true },
        );
      });
      await page.keyboard.up(key);
      assert.equal(await canvas.getAttribute("data-stopped-key"), key);
      assert.ok(await canvas.evaluate((node) => node === document.activeElement));
      await assertStoppedOnOpenFloor(page, `${name} after releasing ${key}`);
    }
    await canvas.click();
    await page.waitForFunction(
      () =>
        document.pointerLockElement === document.activeElement &&
        document.pointerLockElement instanceof HTMLCanvasElement,
    );
    const startX = await page.evaluate(() => window.walkCamera.position.x);
    await page.keyboard.down("w");
    await page.waitForFunction((x) => window.walkCamera.position.x > x + 0.2, startX);
    await activateRoom();
    assert.ok(
      await canvas.evaluate((node) => node === document.activeElement),
      `${name}: showing a visible panel stole canvas focus`,
    );
    await page.waitForFunction(() => window.walkCamera.position.x > 5.5);
    assert.ok(
      await canvas.evaluate((node) => node === document.pointerLockElement),
      `${name}: showing a visible panel released pointer lock`,
    );
    const through = await page.evaluate(() => window.walkCamera.position.toArray());
    // The scaled case begins at x=7.4. The visitor's 22 cm radius should stop the camera at 7.18.
    await page.waitForFunction(() => window.walkCamera.position.x > 7.14);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
    });
    const atCase = await page.evaluate(() => window.walkCamera.position.x);
    assert.ok(
      atCase > 7.14 && atCase <= 7.181,
      `${name}: should stop at the glass case, got ${atCase}`,
    );
    await page.locator('canvas[aria-label="Exhibition view"]').click();
    await page.waitForFunction(() => window.walkCamera.position.x > 14.4);
    // Keep walking into the wall for simulation frames, including on slow software renderers.
    await page.evaluate(async () => {
      for (let frame = 0; frame < 45; frame++) await new Promise(requestAnimationFrame);
    });
    await page.keyboard.up("w");
    const blocked = await page.evaluate(() => window.walkCamera.position.toArray());
    outcomes.push({ name, through, atCase, blocked });
  }
  await editor.bringToFront();
  await editor.evaluate(() => document.exitPointerLock());
  await editor.getByRole("button", { name: "Exit preview", exact: true }).click();
  await editor.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await editor.locator(".scene-tree .object-row").filter({ hasText: "Glass case" }).click();
  await editor.getByRole("button", { name: "Position", exact: true }).click();
  const x = editor.getByRole("textbox", { name: "Glass case transform X (m)", exact: true });
  await x.fill("9");
  await x.press("Enter");
  assert.equal(Number(await x.inputValue()), 9);
  const afterPreview = await walkInEditor(9);
  console.log(JSON.stringify({ beforePreview, afterPreview, outcomes }));
  for (const [phase, { wall, prop, caseX }] of Object.entries({ beforePreview, afterPreview })) {
    assert.ok(wall > -4.6 && wall < -4.54, `${phase}: editor should stop at the wall, got ${wall}`);
    assert.ok(
      prop > caseX - 0.86 && prop <= caseX - 0.819,
      `${phase}: editor should stop at the case placed at ${caseX}, got ${prop}`,
    );
  }
  for (const { name, through, blocked } of outcomes) {
    assert.ok(through[0] > 5.5, `${name}: should cross the doorway, got ${through}`);
    assert.ok(
      blocked[0] > 14.4 && blocked[0] < 14.8,
      `${name}: should reach the wall and stop inside it, got ${blocked}`,
    );
  }
  console.log(
    "Preview and visitor stop when the panel opens, resume walking, cross the doorway, stop at the display case, and reach the far wall after it is hidden.",
  );
} finally {
  await browser?.close();
  await server.close();
}
