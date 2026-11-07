import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const publicationId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";
const snapshot = JSON.parse(
  await readFile(
    new URL("../shared/project/fixtures/m2-publication-project.json", import.meta.url),
    "utf8",
  ),
);
const room = await readFile(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
const model = await readFile(new URL("../../../assets/delivery/test-crate.glb", import.meta.url));
for (const scene of snapshot.scenes) {
  scene.environmentAssetId = environmentId;
  for (const object of scene.objects) {
    object.assetId = modelId;
  }
}
snapshot.scenes[0].environmentTransform = {
  position: [10, 0, 0],
  rotation: [0, 1, 0, 0],
  scale: [1, 1, 1],
};
snapshot.scenes[0].objects[1].visible = false;
snapshot.scenes[1].environmentVisible = false;
snapshot.scenes[1].objects[0].components.push({
  id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  type: "navigationPoint",
  label: "Return to entrance",
  sceneId: snapshot.scenes[1].id,
  viewpointId: snapshot.scenes[1].viewpoints[0].id,
});
const before = JSON.stringify(snapshot);
const errors = [];
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
let release;
let gate = new Promise((resolve) => {
  release = resolve;
});
let assetRequests = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/publications/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/manifest")) {
      await gate;
      return route.fulfill({
        json: {
          publicationId,
          projectId: snapshot.projectId,
          sourceRevision: 4,
          assets: [
            [environmentId, "environment", room],
            [modelId, "model", model],
          ].map(([id, kind, bytes]) => ({
            id,
            kind,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            url: `/api/v1/publications/${publicationId}/assets/${id}/bytes`,
          })),
        },
      });
    }
    if (path.endsWith("/bytes")) {
      assetRequests++;
      return route.fulfill({
        contentType: "model/gltf-binary",
        body: path.includes(environmentId) ? room : model,
      });
    }
    return route.fulfill({ json: snapshot });
  });

  // Observe the rendered scene and camera while keeping the real loader and controls
  const componentPath = new URL("../visitor/ExhibitionCanvas.tsx", import.meta.url).pathname;
  const component = await page.request.get(`${origin}/@fs${componentPath}`);
  assert.ok(component.ok());
  const threePath = (await component.text()).match(/import \* as THREE from "([^"]+)"/)?.[1];
  assert.ok(threePath);
  await page.goto(`${origin}/p/${publicationId}`);
  await page.addScriptTag({
    type: "module",
    content: `import * as THREE from ${JSON.stringify(threePath)};
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (...objects) {
      if (this.isScene) { window.v2Scene = this; }
      return add.apply(this, objects);
    };
    const update = THREE.PerspectiveCamera.prototype.updateProjectionMatrix;
    THREE.PerspectiveCamera.prototype.updateProjectionMatrix = function () {
      window.v2Camera = this;
      return update.call(this);
    };
    window.v2Observed = true;`,
  });
  await page.waitForFunction(() => window.v2Observed);
  release();
  await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
  await page.waitForFunction(() => window.v2Scene?.children.some((node) => node.isGroup));
  const first = snapshot.scenes[0];
  const roots = await page.evaluate(() =>
    window.v2Scene.children
      .filter((node) => node.isGroup)
      .map((node) => ({
        id: node.name,
        position: node.position.toArray(),
        rotation: node.quaternion.toArray(),
        scale: node.scale.toArray(),
        visible: node.visible,
      })),
  );
  assert.deepEqual(
    roots.find((node) => node.id === first.id).position,
    first.environmentTransform.position,
  );
  assert.deepEqual(
    roots.find((node) => node.id === first.id).rotation,
    first.environmentTransform.rotation,
  );
  for (const object of first.objects) {
    const actual = roots.find((node) => node.id === object.id);
    assert.deepEqual(actual.position, object.transform.position);
    assert.deepEqual(actual.scale, object.transform.scale);
    assert.equal(actual.visible, object.visible);
  }
  await page.getByText("Exhibit information", { exact: true }).waitFor();
  assert.ok((await page.locator("figure").innerText()).includes("Unicode 展览"));
  const bold = await page
    .locator("figure span")
    .first()
    .evaluate((node) => getComputedStyle(node).fontWeight);
  assert.ok(Number(bold) >= 600);

  // Saved navigation targets select the destination scene and viewpoint without editing the snapshot
  const navigation = first.objects[0].components.find((item) => item.type === "navigationPoint");
  await page.getByRole("button", { name: navigation.label, exact: true }).click();
  await page.waitForFunction(
    (id) => window.v2Scene?.children.some((node) => node.name === id),
    snapshot.scenes[1].id,
  );
  assert.equal(await page.getByRole("combobox").inputValue(), "1");
  assert.equal(
    await page.evaluate((id) => window.v2Scene.getObjectByName(id).visible, snapshot.scenes[1].id),
    false,
  );
  const expected = snapshot.scenes[1].viewpoints.find(
    (view) => view.id === navigation.viewpointId,
  ).camera;
  const camera = await page.evaluate(() => window.v2Camera.position.toArray());
  camera.forEach((value, index) => assert.ok(Math.abs(value - expected.position[index]) < 0.001));
  // Each click must return to the saved view even when its scene and target have not changed
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.locator("canvas").press("ArrowRight");
    assert.notDeepEqual(
      await page.evaluate(() => window.v2Camera.position.toArray()),
      expected.position,
    );
    await page.getByRole("button", { name: "Return to entrance", exact: true }).click();
    await page.waitForFunction(
      (position) =>
        window.v2Camera.position
          .toArray()
          .every((value, index) => Math.abs(value - position[index]) < 0.001),
      expected.position,
    );
    await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
  }
  assert.equal(JSON.stringify(snapshot), before);

  // Enabled unsupported rules block playback before any model bytes are fetched
  snapshot.scenes[0].rules[0].enabled = true;
  assetRequests = 0;
  gate = Promise.resolve();
  await page.reload();
  await page
    .getByRole("alert")
    .filter({ hasText: "trigger:sceneStart at project.scenes[0].rules[0].trigger" })
    .waitFor();
  assert.equal(assetRequests, 0);
  assert.equal(await page.locator("canvas").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "V2 visitor passed: transforms, visibility, text, captions, navigation and capability rejection",
  );
} finally {
  await browser.close();
}
