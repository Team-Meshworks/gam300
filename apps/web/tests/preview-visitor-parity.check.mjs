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
const standAssetId = "dddddddd-0000-4000-8000-000000000001";
const media = [
  [
    standAssetId,
    "model",
    "../../../assets/delivery/stands-displays/display-rectangle-stand-v1.glb",
    "model/gltf-binary",
  ],
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
first.hotspots = [
  {
    id: "99999999-9999-4999-8999-999999999999",
    objectId: first.objects[0].id,
    position: [-0.5, 0.7, 0.5],
  },
];
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
const standId = "dddddddd-0000-4000-8000-000000000002";
const revisit = {
  ...first.objects[0].components.find((item) => item.type === "navigationPoint"),
  id: "dddddddd-0000-4000-8000-000000000004",
  label: "Revisit this room",
  sceneId: first.id,
  viewpointId: first.viewpoints[0].id,
};
first.objects[0].components.push(revisit);
first.objects.push({
  ...structuredClone(first.objects[0]),
  id: standId,
  assetId: standAssetId,
  components: [{ ...video, id: "dddddddd-0000-4000-8000-000000000003", loop: false }],
  transform: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
});
first.rules = [
  {
    id: "dddddddd-0000-4000-8000-000000000005",
    enabled: true,
    trigger: { type: "click", targetId: revisit.id },
    actions: [{ type: "navigateScene", sceneId: first.id, viewpointId: revisit.viewpointId }],
  },
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
  editor.setDefaultTimeout(30000);
  const observeScenes = (page) =>
    page.addInitScript(() => {
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.parityScenes = [];
      window.parityViews = new WeakMap();
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      window.paintedText = new WeakMap();
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        window.paintedText.set(this.canvas, (window.paintedText.get(this.canvas) ?? "") + text);
        return fillText.call(this, text, ...args);
      };
      window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
        const scene = event.detail;
        if (!scene.isScene) return;
        window.parityScenes.push(scene);
        scene.onAfterRender = function (renderer, scene, camera) {
          window.parityViews.set(scene, { renderer, camera });
          delete this.onAfterRender;
        };
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
  // Compare actual wall pixels from inside the Starter room, with the same eye position
  // in all three modes. A direction facing away from the player's old sun rendered black.
  const readRoom = (page) =>
    page.evaluate(() => {
      const scene = window.parityScenes.findLast(
        (item) =>
          item.getObjectByName("Wall_Right") &&
          item.children.some((node) => node.isLight) &&
          item.background,
      );
      const view = window.parityViews.get(scene);
      const { renderer } = view;
      const camera = view.camera.clone();
      camera.position.set(0, 1.5, 0);
      const gl = renderer.getContext();
      const walls = [];
      for (const [x, z] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        camera.lookAt(x, 1.5, z);
        renderer.render(scene, camera);
        const pixel = new Uint8Array(4);
        gl.readPixels(
          gl.drawingBufferWidth >> 1,
          gl.drawingBufferHeight >> 1,
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        walls.push([...pixel].slice(0, 3));
      }
      let marker;
      scene.traverseVisible((node) => {
        if (node.isSprite && node.material.map?.image) {
          marker = {
            image: node.material.map.image.currentSrc,
            position: node.position.toArray(),
            scale: node.scale.toArray(),
          };
        }
      });
      return { walls, marker };
    });
  // Inspect the actual texture on the stand, before any gesture or opening the media panel.
  const waitForStand = (page, requireSound = false) =>
    page.waitForFunction(
      ({ id, requireSound }) => {
        const scene = window.parityScenes.findLast((entry) => entry.getObjectByName(id));
        let playing = false;
        scene?.traverse((node) => {
          const map = node.material?.map;
          if (!map?.isVideoTexture) return;
          for (let owner = node; owner; owner = owner.parent) {
            if (owner.name === id || owner.userData.objectId === id) {
              playing ||=
                (!requireSound || (!map.image.muted && map.image.volume > 0)) &&
                map.image.loop &&
                !map.image.paused &&
                map.image.currentTime > 0;
              break;
            }
          }
        });
        return playing;
      },
      { id: standId, requireSound },
      { timeout: 15000 },
    );
  await waitForStand(editor);
  await editor.keyboard.press("Shift");
  await waitForStand(editor, true);
  const authoredRoom = await readRoom(editor);
  assert.ok(authoredRoom.marker, "The editor renders the attached icon");
  assert.ok(
    authoredRoom.walls.every((rgb) => Math.min(...rgb) > 20),
    JSON.stringify(authoredRoom.walls),
  );
  const authoredTransform = await editor.evaluate((id) => {
    const root = window.parityScenes
      .map((scene) => scene.getObjectByName(id))
      .filter(Boolean)
      .at(-1);
    return (
      root && {
        position: root.position.toArray(),
        rotation: root.quaternion.toArray(),
        scale: root.scale.toArray(),
        visible: root.visible,
      }
    );
  }, first.objects[0].id);
  assert.ok(authoredTransform, "The editor renders the authored model");
  await editor.getByRole("button", { name: "Preview", exact: true }).click();
  await editor.getByRole("status").getByText("Exhibition ready").waitFor();
  await waitForStand(editor, true);
  const visitor = await browser.newPage();
  visitor.setDefaultTimeout(30000);
  await observeScenes(visitor);
  await visitor.addInitScript(() =>
    Object.defineProperty(document, "hidden", { configurable: true, value: true }),
  );
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
  const stand = visitor.locator("video[data-stand-video]");
  await visitor.waitForFunction(
    () => document.querySelector("video[data-stand-video]")?.readyState >= 2,
  );
  assert.ok(
    await stand.evaluate((video) => video.paused),
    "An initially hidden stand waits for visibility",
  );
  await visitor.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitForStand(visitor);
  await visitor.keyboard.press("Shift");
  await waitForStand(visitor, true);
  for (const page of [editor, visitor]) {
    const video = page.locator("video[data-stand-video]");
    await video.evaluate((node) => {
      node.pause();
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.ok(
      await video.evaluate((node) => node.paused),
      "Returning to a tab preserves an explicit pause",
    );
    const oldCanvas = await page.locator(".visitor-canvas canvas").elementHandle();
    await page.locator(".visitor-information > summary").click();
    await page.getByRole("button", { name: revisit.label }).click();
    await page.waitForFunction((canvas) => !canvas.isConnected, oldCanvas);
    await page.getByRole("status").getByText("Exhibition ready").waitFor();
    await waitForStand(page, true);
    assert.equal(await page.getByRole("combobox").inputValue(), "0");
    if (await page.locator(".visitor-information").evaluate((details) => details.open))
      await page.locator(".visitor-information > summary").click();
  }
  for (const page of [visitor]) {
    const room = await readRoom(page);
    assert.deepEqual(room.walls, authoredRoom.walls, "All four interior walls match the editor");
    assert.deepEqual(
      room.marker,
      authoredRoom.marker,
      "The attached hotspot uses the editor icon, anchor and round scale",
    );
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
    const { position, rotation, scale, visible } = renderedObject;
    assert.deepEqual(
      { position, rotation, scale, visible },
      authoredTransform,
      "The visitor model transform and visibility match the editor",
    );
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
  assert.deepEqual(saved.document(), project, "Viewing does not mutate the authored draft");
  console.log("PASS visitor wall lighting, hotspot and published interactions");
} finally {
  await browser?.close();
  await server.close();
}
