import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { blankProject, serveProject } from "./authoring-project-fixture.mjs";

const id = "11111111-1111-4111-8111-111111111112";
const moduleId = "11111111-1111-4111-8111-111111111113";
const pub = "11111111-1111-4111-8111-111111111111";
const bytes = readFileSync(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
const sha256 = createHash("sha256").update(bytes).digest("hex");
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
const doorway = scene("Doorway", [room]);
const project = { ...blankProject, scenes: [doorway] };
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const observe = (page) =>
    page.addInitScript(() => {
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
        const renderer = event.detail;
        if (!renderer.isWebGLRenderer) return;
        const render = renderer.render;
        renderer.render = function (scene, camera) {
          window.walkCamera = camera;
          return render.call(this, scene, camera);
        };
      });
    });
  const editor = await browser.newPage();
  await observe(editor);
  const saved = await serveProject(editor, origin, project);
  const projectAssets = `/api/v1/projects/${project.projectId}/assets`;
  await editor.route(`**${projectAssets}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return path === projectAssets
      ? route.fulfill({
          json: [
            {
              id,
              name: "room",
              kind: "environment",
              sha256,
              url: `${projectAssets}/${id}/bytes`,
              category: null,
              thumbnail: null,
            },
            {
              id: moduleId,
              name: "room",
              kind: "model",
              sha256,
              url: `${projectAssets}/${moduleId}/bytes`,
              category: null,
              thumbnail: null,
            },
          ],
        })
      : route.fulfill({ contentType: "model/gltf-binary", body: bytes });
  });
  await editor.goto(saved.url);
  await editor
    .getByRole("status")
    .filter({ hasText: "Scene ready" })
    .waitFor({ timeout: 10000 })
    .catch(async (e) => {
      throw new Error(e.message + "\n" + (await editor.locator("body").innerText()));
    });
  await editor.getByRole("button", { name: "Preview", exact: true }).click();
  const visitor = await browser.newPage();
  await observe(visitor);
  await visitor.route("**/api/v1/publications/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/bytes"))
      return route.fulfill({ contentType: "model/gltf-binary", body: bytes });
    return route.fulfill({
      json: path.endsWith("/manifest")
        ? {
            publicationId: pub,
            projectId: project.projectId,
            sourceRevision: 1,
            assets: [
              {
                id,
                kind: "environment",
                sha256,
                url: `/api/v1/publications/${pub}/assets/${id}/bytes`,
              },
              {
                id: moduleId,
                kind: "model",
                sha256,
                url: `/api/v1/publications/${pub}/assets/${moduleId}/bytes`,
              },
            ],
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
    await page.locator('canvas[aria-label="Exhibition view"]').click();
    await page.keyboard.down("w");
    await page.waitForFunction(() => window.walkCamera.position.x > 5.5);
    const through = await page.evaluate(() => window.walkCamera.position.toArray());
    await page.waitForFunction(() => window.walkCamera.position.x > 14.4);
    // Keep walking into the wall for simulation frames, including on slow software renderers.
    await page.evaluate(async () => {
      for (let frame = 0; frame < 45; frame++) await new Promise(requestAnimationFrame);
    });
    await page.keyboard.up("w");
    const blocked = await page.evaluate(() => window.walkCamera.position.toArray());
    outcomes.push({ name, through, blocked });
  }
  console.log(JSON.stringify(outcomes));
  for (const { name, through, blocked } of outcomes) {
    assert.ok(through[0] > 5.5, `${name}: should cross the doorway, got ${through}`);
    assert.ok(
      blocked[0] > 14.4 && blocked[0] < 14.8,
      `${name}: should reach the wall and stop inside it, got ${blocked}`,
    );
  }
  console.log("Preview and visitor walk through connected doorways and stop at solid walls.");
} finally {
  await browser?.close();
  await server.close();
}
