import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";

let browser;
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const output = fileURLToPath(new URL("../test-results/hotspot-placement/", import.meta.url));
const template = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
await mkdir(output, { recursive: true });

async function imported(page, project, document) {
  project.setDocument(document);
  await page.reload();
  await openSavedProject(page);
}

async function recovery(page, project, count, position) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const doc = project.document();
    if (
      (doc?.scenes[0]?.hotspots?.length ?? 0) === count &&
      (position === undefined ||
        JSON.stringify(doc.scenes[0].hotspots[0]?.position) === JSON.stringify(position))
    )
      return doc;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Recovery did not reach ${count} hotspots: ${await page.locator("body").innerText()}`,
  );
}

async function makeFixture(page, assetId, scale, rotation) {
  return page.evaluate(
    async ({ template, assetId, scale, rotation }) => {
      const source = await (await fetch("/graphics/scene.ts")).text();
      const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
      const { editorModelCache } = await import("/graphics/scene.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const lease = await editorModelCache.acquire(
        assets.find((a) => a.id === assetId),
        new AbortController().signal,
      );
      const local = new THREE.Box3().setFromObject(lease.value.model);
      const owner = new THREE.Group();
      owner.add(lease.value.model.clone(true));
      owner.position.set(0, 5, 0);
      owner.scale.fromArray(scale);
      owner.quaternion.setFromEuler(new THREE.Euler(...rotation));
      const world = new THREE.Box3().setFromObject(owner);
      const centre = world.getCenter(new THREE.Vector3());
      const size = world.getSize(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
      camera.position
        .copy(centre)
        .add(new THREE.Vector3(0, 0, Math.max(size.x, size.y, size.z, 1) * 3 + 2));
      camera.lookAt(centre);
      const doc = structuredClone(template);
      doc.scenes[0].objects = [
        {
          ...doc.scenes[0].objects[0],
          assetId,
          name: assetId,
          transform: {
            position: owner.position.toArray(),
            rotation: owner.quaternion.toArray(),
            scale,
          },
        },
      ];
      doc.scenes[0].startCamera = {
        position: camera.position.toArray(),
        rotation: camera.quaternion.toArray(),
        fovDegrees: 40,
      };
      // Aim at the upper part of stands/panels, where their display face is solid.
      const hit = centre.clone();
      if (assetId.includes("stand")) hit.y = world.max.y - size.y * 0.2;
      lease.release();
      return {
        doc,
        local: { min: local.min.toArray(), max: local.max.toArray() },
        hit: hit.toArray(),
      };
    },
    { template, assetId, scale, rotation },
  );
}

async function screenPoint(page, doc, point) {
  return page.evaluate(
    async ({ doc, point }) => {
      const source = await (await fetch("/graphics/scene.ts")).text();
      const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
      const rect = document.querySelector(".viewport-stage canvas").getBoundingClientRect();
      const pose = doc.scenes[0].startCamera;
      const camera = new THREE.PerspectiveCamera(70, rect.width / rect.height, 0.1, 100);
      camera.position.fromArray(pose.position);
      camera.quaternion.fromArray(pose.rotation);
      camera.updateMatrixWorld();
      const ndc = new THREE.Vector3(...point).project(camera);
      return {
        x: rect.x + ((ndc.x + 1) * rect.width) / 2,
        y: rect.y + ((1 - ndc.y) * rect.height) / 2,
      };
    },
    { doc, point },
  );
}

async function dragHotspot(page, point) {
  const button = await page.getByRole("button", { name: "Add Hotspot", exact: true }).boundingBox();
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.mouse.move(point.x + 1, point.y, { steps: 2 });
  await page.mouse.up();
}

async function visiblePlacement(page, doc, local, anchor) {
  return page.evaluate(
    async ({ doc, local, anchor }) => {
      const source = await (await fetch("/graphics/scene.ts")).text();
      const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
      const rect = document.querySelector(".viewport-stage canvas").getBoundingClientRect();
      const pose = doc.scenes[0].startCamera;
      const camera = new THREE.PerspectiveCamera(
        pose.fovDegrees,
        rect.width / rect.height,
        0.1,
        100,
      );
      camera.position.fromArray(pose.position);
      camera.quaternion.fromArray(pose.rotation);
      camera.updateMatrixWorld();
      const owner = new THREE.Group();
      const transform = doc.scenes[0].objects[0].transform;
      owner.position.fromArray(transform.position);
      owner.quaternion.fromArray(transform.rotation);
      owner.scale.fromArray(transform.scale);
      owner.updateMatrixWorld();
      const bounds = new THREE.Box3();
      for (const x of [local.min[0], local.max[0]])
        for (const y of [local.min[1], local.max[1]])
          for (const z of [local.min[2], local.max[2]])
            bounds.expandByPoint(owner.localToWorld(new THREE.Vector3(x, y, z)).project(camera));
      const centre = owner.localToWorld(
        new THREE.Vector3(...anchor).add(new THREE.Vector3(0, 0.3, 0)),
      );
      const radius = 0.3 * Math.min(transform.scale[0], transform.scale[1]);
      const right = centre
        .clone()
        .add(new THREE.Vector3(radius, 0, 0).applyQuaternion(camera.quaternion))
        .project(camera);
      const bottom = centre
        .clone()
        .add(new THREE.Vector3(0, -radius, 0).applyQuaternion(camera.quaternion))
        .project(camera);
      return {
        leftGap: ((bounds.min.x - right.x) * rect.width) / 2,
        topGap: ((bottom.y - bounds.max.y) * rect.height) / 2,
        size: Math.max(
          ((bounds.max.x - bounds.min.x) * rect.width) / 2,
          ((bounds.max.y - bounds.min.y) * rect.height) / 2,
        ),
      };
    },
    { doc, local, anchor },
  );
}

try {
  const variants = [
    ["test-crate-v1", [1, 1, 1], [0, 0, 0]],
    ["display-square-panel-v1", [1, 1, 1], [0, 0, 0]],
    ["display-rectangle-stand-v1", [1, 1, 1], [0, 0, 0]],
    ["test-crate-v1", [0.2, 0.4, 0.3], [0.1, 0.7, 0.2]],
    ["display-square-panel-v1", [3, 1.5, 0.5], [0.1, -0.45, -0.2]],
    ["display-square-panel-v1", [1.5, 1, 0.5], [0, Math.PI, 0]],
  ];
  for (const [index, [assetId, scale, rotation]] of variants.entries()) {
    if (process.argv[3] !== undefined && index !== Number(process.argv[3])) continue;
    browser = await launchBrowser({ target: url, args: ["--enable-unsafe-swiftshader"] });
    // Leave space for the scene tree beside wide, nonuniformly scaled objects.
    const context = await browser.newContext({ viewport: { width: 1920, height: 1024 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = await serveProject(page, url);
    await page.goto(project.url);
    await page
      .getByRole("status")
      .filter({ hasText: "Scene ready" })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `${error.message}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`,
        );
      });
    const fixture = await makeFixture(page, assetId, scale, rotation);
    const { doc, local } = fixture;
    await imported(page, project, doc);
    await page.locator("[data-object-id]").first().click();
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    const clickDoc = await recovery(page, project, 1);
    const anchor = clickDoc.scenes[0].hotspots[0].position;
    const placement = await visiblePlacement(page, doc, local, anchor);
    assert.ok(
      placement.leftGap > 0 && placement.leftGap < placement.size * 0.05,
      "slightly outside the visible left edge",
    );
    assert.ok(
      placement.topGap > 0 && placement.topGap < placement.size * 0.05,
      "slightly above the visible top edge",
    );
    await page.screenshot({ path: `${output}/${index}-${assetId}.png` });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await recovery(page, project, 0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    assert.deepEqual(
      (await recovery(page, project, 1)).scenes[0].hotspots,
      clickDoc.scenes[0].hotspots,
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await recovery(page, project, 0);
    // The room is unsupported: drag must pick the actual exhibit, not fall back to selection.
    await page.locator(".environment-row").click();
    const point = await screenPoint(page, doc, fixture.hit);
    await dragHotspot(page, point);
    const dragDoc = await recovery(page, project, 1);
    assert.deepEqual(
      dragDoc.scenes[0].hotspots[0].position,
      anchor,
      "click and drag share one anchor",
    );
    assert.equal(dragDoc.scenes[0].hotspots[0].objectId, doc.scenes[0].objects[0].id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSavedProject(page);
    await page.locator("[data-object-id] .hotspot-indicator").first().waitFor();
    assert.deepEqual(
      (await recovery(page, project, 1)).scenes[0].hotspots,
      dragDoc.scenes[0].hotspots,
    );
    // Existing authored positions remain byte-for-byte identical through import and edits.
    const legacy = structuredClone(dragDoc);
    legacy.scenes[0].hotspots[0].position = [-0.2, 0.1, -0.3];
    await imported(page, project, legacy);
    await page.locator("[data-object-id]").first().click();
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    await page.getByText("Each object can have at most one hotspot", { exact: true }).waitFor();
    assert.deepEqual(
      (await recovery(page, project, 1, [-0.2, 0.1, -0.3])).scenes[0].hotspots[0].position,
      [-0.2, 0.1, -0.3],
    );
    await page.locator(".environment-row").click();
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    await page.getByText("Select an object to attach the hotspot to", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    await browser.close();
    browser = undefined;
    console.log(
      `PASS: ${assetId} ${scale} / ${rotation}: click, drag, visible upper-left bounds, undo/redo, reload, legacy position and unsupported room`,
    );
  }
} finally {
  await browser?.close();
}
