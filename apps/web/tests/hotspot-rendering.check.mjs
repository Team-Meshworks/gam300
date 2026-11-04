import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const base = process.argv[2] ?? "http://127.0.0.1:5173/";
const output = fileURLToPath(new URL("../test-results/hotspot-placement/", import.meta.url));
await mkdir(output, { recursive: true });
const fixture = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/hotspot-harness.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><style>body{margin:0}</style><div id="host" style="width:800px;height:600px"></div>',
    }),
  );
  await page.goto(new URL("hotspot-harness.html", base).href);
  const result = await page.evaluate(async (fixture) => {
    const source = await (await fetch("/graphics/scene.ts")).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const { initScene } = await import("/graphics/scene.ts");
    const hotspotPath = source.match(/from "([^"]*asset-runtime\/hotspot[^"]*)"/)[1];
    const { HOTSPOT_ASSET } = await import(hotspotPath);
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const { promise, resolve, reject } = Promise.withResolvers();
    const originalAdd = THREE.Object3D.prototype.add;
    let scene;
    THREE.Object3D.prototype.add = function (...objects) {
      if (this.isScene && this.background?.isColor) scene = this;
      return originalAdd.apply(this, objects);
    };
    let handle;
    try {
      handle = initScene(
        document.getElementById("host"),
        [...assets.filter((a) => a.id === "test-crate-v1"), HOTSPOT_ASSET],
        {
          onStatus: (status) => (status === "ready" ? resolve() : reject(new Error(status))),
          onThumbnail() {},
          onSelect() {},
          onTransform() {},
          onObjectClick() {},
          onUpdate() {},
        },
      );
    } finally {
      THREE.Object3D.prototype.add = originalAdd;
    }
    await promise;
    const object = {
      ...fixture.scenes[0].objects[0],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    };
    const saved = {
      ...fixture.scenes[0],
      objects: [object],
      hotspots: [],
      startCamera: { position: [0, 1, 6], rotation: [0, 0, 0, 1], fovDegrees: 40 },
    };
    handle.update([object], null, saved);
    const anchor = handle.getHotspotAnchor(object.id);
    const upperCase = handle.getHotspotAnchor(object.id.toUpperCase());
    const unsupported = handle.getHotspotAnchor(saved.id);
    // Legacy authored point intentionally lies inside the model and behind this green panel.
    saved.hotspots = [
      { id: "99999999-9999-4999-8999-999999999999", objectId: object.id, position: [0, 0, 0] },
    ];
    handle.update([object], null, saved);
    let sprite;
    scene.traverse((node) => {
      if (node.isSprite && node.visible) sprite = node;
    });
    const owner = sprite.parent;
    const originalWorld = sprite.getWorldPosition(new THREE.Vector3()).toArray();
    const moved = {
      ...object,
      transform: {
        position: [2, 3, -1],
        rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.8, -0.3)).toArray(),
        scale: [0.5, 2, 1.5],
      },
    };
    handle.update([moved], null, { ...saved, objects: [moved] });
    const expected = new THREE.Vector3(0, 0.3, 0)
      .multiply(new THREE.Vector3(...moved.transform.scale))
      .applyQuaternion(new THREE.Quaternion(...moved.transform.rotation))
      .add(new THREE.Vector3(...moved.transform.position));
    const transformError = sprite.getWorldPosition(new THREE.Vector3()).distanceTo(expected);
    const scaledMarkerSize = sprite.getWorldScale(new THREE.Vector3()).toArray();
    const anchorAfterTransform = handle.getHotspotAnchor(object.id);
    handle.update([object], null, saved);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 }),
    );
    panel.position.set(0, 1, 2);
    scene.add(panel);
    // Test-only handle, scoped to this renderer harness.
    window.hotspotHarness = { handle, sprite, panel, owner };
    return {
      anchor,
      upperCase,
      unsupported,
      anchorAfterTransform,
      transformError,
      scaledMarkerSize,
      originalWorld,
      local: sprite.position.toArray(),
      depthTest: sprite.material.depthTest,
      depthWrite: sprite.material.depthWrite,
      orderAboveModel: sprite.renderOrder > panel.renderOrder,
      storedPosition: saved.hotspots[0].position,
    };
  }, fixture);
  assert.deepEqual(result.anchor, result.upperCase);
  assert.equal(result.unsupported, undefined);
  assert.notDeepEqual(
    result.anchor,
    result.anchorAfterTransform,
    "new attachments account for the transformed visible edge",
  );
  assert.ok(result.transformError < 1e-12);
  assert.ok(
    Math.abs(result.scaledMarkerSize[0] - result.scaledMarkerSize[1]) < 1e-12,
    "nonuniform owner scale keeps the marker round",
  );
  assert.deepEqual(result.local, [0, 0.3, 0]);
  assert.deepEqual(result.storedPosition, [0, 0, 0]);
  assert.equal(result.depthTest, false);
  assert.equal(result.depthWrite, false);
  assert.equal(result.orderAboveModel, true);

  async function goldPixels(name) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const png = await page.locator("canvas").screenshot({ path: `${output}/${name}.png` });
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let gold = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] > data[i + 1] + 25 && data[i + 1] > data[i + 2] + 15 && data[i] > 90) gold++;
      return gold;
    }, png.toString("base64"));
  }
  assert.ok(
    (await goldPixels("visible-through-geometry")) > 30,
    "the gold marker renders through opaque geometry",
  );
  await page.evaluate(() => window.hotspotHarness.handle.modeManager.setMode("visitor"));
  assert.equal(await page.evaluate(() => window.hotspotHarness.sprite.visible), false);
  assert.equal(await goldPixels("preview-no-authoring-marker"), 0);
  await page.evaluate(() => window.hotspotHarness.handle.modeManager.setMode("editor"));
  assert.ok((await goldPixels("restored-editor-marker")) > 30);
  await page.evaluate(() => {
    const { handle, panel } = window.hotspotHarness;
    panel.parent.remove(panel);
    panel.geometry.dispose();
    panel.material.dispose();
    handle.dispose();
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: view-aware new anchors, case-insensitive owner, unsupported room, unchanged transformed legacy position, actual pixels through opaque geometry, preview hiding and editor restoration",
  );
} finally {
  await browser.close();
}
