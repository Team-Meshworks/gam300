import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
);
const ids = [
  "11111111-1111-4111-8111-111111111112",
  "11111111-1111-4111-8111-111111111113",
  "11111111-1111-4111-8111-111111111114",
  "11111111-1111-4111-8111-111111111116",
];
const media = [
  [ids[0], "environment", "../../../assets/delivery/test-room.glb", "model/gltf-binary"],
  [ids[1], "model", "../../../assets/delivery/test-crate.glb", "model/gltf-binary"],
  [ids[2], "image", "../../../assets/delivery/sample-media/sample-coast.webp", "image/webp"],
  [
    ids[3],
    "video",
    "../../../assets/delivery/sample-media/sample-sunset-motion.webm",
    "video/webm",
  ],
].map(([id, kind, file, contentType]) => {
  const bytes = readFileSync(new URL(file, import.meta.url));
  return {
    id,
    kind,
    bytes,
    contentType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});
const first = structuredClone(fixture.scenes[0]);
const second = structuredClone(fixture.scenes[1]);
first.name = "First gallery";
second.name = "Second gallery";
for (const scene of [first, second]) {
  scene.environmentAssetId = ids[0];
  scene.objects.forEach((object) => {
    object.assetId = ids[1];
  });
  scene.rules = [];
}
first.objects[0].components = first.objects[0].components.filter((item) =>
  ["hotspot", "text", "image", "video", "navigationPoint"].includes(item.type),
);
first.objects[0].components.find((item) => item.type === "image").assetId = ids[2];
const label = first.objects[0].components.find((item) => item.type === "text");
label.caption = "Gallery wall caption";
label.placement = {
  position: [0, 0.5, 0.51],
  rotation: [0, 0, 0, 1],
  scale: [1, 0.6, 1],
};
const video = first.objects[0].components.find((item) => item.type === "video");
video.assetId = ids[3];
first.rules = [
  {
    id: "11111111-1111-4111-8111-111111111115",
    enabled: true,
    trigger: { type: "click", targetId: first.objects[0].components[0].id },
    actions: [
      { type: "showPanel", panelId: first.objects[0].components[1].id },
      { type: "playMedia", mediaId: video.id },
    ],
  },
];
// Enter B via A's navigation point. Its entry zone tries to send the visitor straight back.
second.environmentAssetId = null;
second.startCamera.position = [0, 0.9, 8];
second.viewpoints[0].camera.position = [0, 0.9, 5];
second.objects[0].transform.position = [2, 0, 0];
second.zones = [5, 3].map((z, i) => ({
  id: `22222222-2222-4222-8222-22222222222${i}`,
  name: i ? "Walk back" : "Arrival",
  transform: { position: [0, 1, z], rotation: [0, 0, 0, 1], scale: [1, 2, 1] },
}));
second.rules = [
  ...second.zones.map((zone) => ({ type: "zoneEnter", zoneId: zone.id })),
  { type: "gaze", targetId: second.objects[0].id, seconds: 0.2 },
].map((trigger, i) => ({
  id: `33333333-3333-4333-8333-33333333333${i}`,
  enabled: true,
  trigger,
  actions: [
    {
      type: "navigateScene",
      sceneId: first.id,
      viewpointId: first.viewpoints[0].id,
    },
  ],
}));
const project = {
  ...fixture,
  title: "Parity exhibition",
  scenes: [first, second],
};
const publicationId = "11111111-1111-4111-8111-111111111111";
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({
    target: origin,
    args: ["--enable-unsafe-swiftshader"],
  });
  const editor = await browser.newPage();
  const observeScenes = (page) =>
    page.addInitScript(() => {
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.parityScenes = [];
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      window.paintedText = new WeakMap();
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        window.paintedText.set(this.canvas, (window.paintedText.get(this.canvas) ?? "") + text);
        return fillText.call(this, text, ...args);
      };
      window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
        if (event.detail.isScene) window.parityScenes.push(event.detail);
      });
    });
  await observeScenes(editor);
  const saved = await serveProject(editor, origin, project);
  const projectAssets = `/api/v1/projects/${project.projectId}/assets`;
  await editor.route(`**${projectAssets}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === projectAssets)
      return route.fulfill({
        json: media.map((item) => ({
          id: item.id,
          name: item.kind,
          kind: item.kind,
          sha256: item.sha256,
          url: `${projectAssets}/${item.id}/bytes`,
          category: null,
          thumbnail: null,
        })),
      });
    const item = media.find((asset) => path.endsWith(`/${asset.id}/bytes`));
    return item
      ? route.fulfill({ contentType: item.contentType, body: item.bytes })
      : route.fallback();
  });
  await editor.goto(saved.url);
  await editor.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await editor.getByRole("button", { name: "Preview", exact: true }).click();
  const visitor = await browser.newPage();
  await observeScenes(visitor);
  await visitor.route("**/api/v1/publications/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const item = media.find((asset) => path.endsWith(`/${asset.id}/bytes`));
    if (item) return route.fulfill({ contentType: item.contentType, body: item.bytes });
    return route.fulfill({
      json: path.endsWith("/manifest")
        ? {
            publicationId,
            projectId: project.projectId,
            sourceRevision: 1,
            assets: media.map((asset) => ({
              id: asset.id,
              kind: asset.kind,
              sha256: asset.sha256,
              url: `/api/v1/publications/${publicationId}/assets/${asset.id}/bytes`,
            })),
          }
        : project,
    });
  });
  await visitor.goto(`${origin}/p/${publicationId}`);
  await visitor.getByRole("status").getByText("Exhibition ready").waitFor();
  await editor.getByRole("status").getByText("Exhibition ready").waitFor({ timeout: 5000 });
  await editor.waitForTimeout(1000);
  const canvasHash = async (page) =>
    createHash("sha256")
      .update(
        await page.screenshot({
          clip: { x: 200, y: 200, width: 800, height: 350 },
        }),
      )
      .digest("hex");
  assert.equal(
    await canvasHash(editor),
    await canvasHash(visitor),
    "Both routes render the same initial camera view",
  );
  const rendered = [];
  for (const page of [editor, visitor]) {
    assert.equal(await page.locator("canvas[aria-label='Exhibition view']").count(), 1);
    const renderedObject = await page.evaluate((id) => {
      const root = window.parityScenes
        .map((scene) => scene.getObjectByName(id))
        .filter(Boolean)
        .at(-1);
      if (!root) return null;
      let meshes = 0;
      root.traverse((node) => {
        if (node.isMesh) meshes++;
      });
      return {
        position: root.position.toArray(),
        rotation: root.quaternion.toArray(),
        scale: root.scale.toArray(),
        visible: root.visible,
        meshes,
        panels: root.getObjectByName("Display content")?.children.map((mesh) => ({
          text: window.paintedText.get(mesh.material.map.image),
          y: mesh.position.y,
          height: mesh.geometry.parameters.height,
        })),
      };
    }, first.objects[0].id);
    assert.ok(renderedObject?.meshes > 0, "Authored model is present in the rendered scene");
    const [body, caption] = renderedObject.panels;
    assert.ok(body.text.startsWith("An exhibit"));
    assert.equal(caption.text, label.caption);
    assert.ok(caption.y < body.y);
    assert.equal(body.height + caption.height, label.placement.scale[1]);
    rendered.push(renderedObject);
    await page.getByText("Exhibit information", { exact: true }).first().click();
    await page.getByRole("region", { name: "Exhibit information" }).waitFor();
    assert.ok((await page.locator("figure").first().innerText()).includes("Unicode 展览"));
    await page.getByRole("img", { name: "Synthetic exhibit image" }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("img")].some(
        (image) =>
          image.alt === "Synthetic exhibit image" && image.complete && image.naturalWidth > 0,
      ),
    );
    const textPanel = page.locator(`[data-component-id="${first.objects[0].components[1].id}"]`);
    await textPanel.getByRole("button", { name: "Close panel" }).click();
    assert.equal(await textPanel.isVisible(), false);
    await page.getByRole("button", { name: "Learn more" }).click();
    await textPanel.waitFor({ state: "visible" });
    await page.waitForFunction((id) => {
      const video = document.querySelector(`[data-component-id="${id}"] video`);
      return video && !video.paused && video.currentTime > 0;
    }, video.id);
    for (const input of ["walk", "look"]) {
      await page.getByRole("button", { name: "Next room", exact: true }).click();
      await page.getByText("Automatic scene navigation stopped at a repeated scene.").waitFor();
      assert.equal(await page.getByRole("combobox").inputValue(), "1");
      const canvas = page.getByLabel("Exhibition view", { exact: true });
      await canvas.focus();
      if (input === "walk") {
        await page.keyboard.down("w");
      } else {
        // Alt-drag uses the unlocked FPS look handler (0.002 radians per pixel).
        const box = await canvas.boundingBox();
        const x = box.x + box.width / 2,
          y = box.y + box.height / 3;
        await page.keyboard.down("Alt");
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 190, y, { steps: 10 });
        await page.mouse.up();
        await page.keyboard.up("Alt");
      }
      try {
        await page.waitForFunction(
          () => document.querySelector(".visitor-scene-picker select")?.value === "0",
        );
      } catch (error) {
        throw new Error(`Failed to return to A by ${input} on ${page.url()}`, { cause: error });
      } finally {
        if (input === "walk") await page.keyboard.up("w");
      }
      await page.getByRole("status").getByText("Exhibition ready").waitFor();
      if (!(await page.locator(".visitor-information").evaluate((details) => details.open)))
        await page.locator(".visitor-information > summary").click();
    }
    assert.deepEqual(await page.getByRole("combobox").locator("option").allTextContents(), [
      "First gallery",
      "Second gallery",
    ]);
    await page.getByRole("combobox").selectOption("1");
    await page.getByRole("status").getByText("Exhibition ready").waitFor();
    await page.getByRole("button", { name: "Reset view" }).click();
  }
  assert.deepEqual(
    rendered[0],
    rendered[1],
    "Preview and visitor render the same authored model transform",
  );
  await editor.getByRole("button", { name: "Restart preview" }).click();
  assert.equal(await editor.getByRole("combobox").inputValue(), "0");
  await editor.getByRole("button", { name: "Exit preview" }).click();
  assert.deepEqual(saved.document(), project, "Preview does not mutate the authored draft");
  console.log(
    "Preview and publication use the same visitor controls, scene navigation, reset and draft isolation",
  );
} finally {
  await browser?.close();
  await server.close();
}
