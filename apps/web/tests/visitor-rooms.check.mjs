import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const publicationId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const moduleId = "33333333-3333-4333-8333-333333333333";
const crateId = "44444444-4444-4444-8444-444444444444";
const starter = await readFile(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
const crate = await readFile(new URL("../../../assets/delivery/test-crate.glb", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha(starter), "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1");
// Change metadata only, so the negative case has the same geometry and a different digest.
const lookalike = Buffer.from(starter);
const generator = lookalike.indexOf("Khronos glTF Blender I/O");
assert.notEqual(generator, -1);
lookalike[generator] = "L".charCodeAt(0);
const snapshot = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
snapshot.title = "Adjoining room rendering";
delete snapshot.scenes[0].hotspots;
delete snapshot.scenes[0].interactions;
const room = (id, position, rotation = [0, 0, 0, 1]) => ({
  id,
  name: "Adjoining room",
  assetId: moduleId,
  transform: { position, rotation, scale: [1, 1, 1] },
});
snapshot.scenes[0].environmentAssetId = environmentId;
snapshot.scenes[0].startCamera = {
  position: [0, 1.5, 0],
  rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
  fovDegrees: 40,
};
snapshot.scenes[0].objects = [
  room("55555555-5555-4555-8555-555555555555", [10, 0, 0]),
  room("66666666-6666-4666-8666-666666666666", [10, 0, 10], [0, Math.SQRT1_2, 0, Math.SQRT1_2]),
  {
    id: "77777777-7777-4777-8777-777777777777",
    name: "Visible through the doorway",
    assetId: crateId,
    transform: { position: [8, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  },
];
snapshot.scenes.push({
  ...structuredClone(snapshot.scenes[0]),
  id: "88888888-8888-4888-8888-888888888888",
  name: "Single room",
  objects: [],
});

let mode = "canonical";
let releaseManifest;
let manifestGate;
const requests = [];
const errors = [];
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/publications/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const bytesFor = (id) => {
      if (id === crateId) return crate;
      if (id === environmentId && ["different-environment", "different-both"].includes(mode))
        return lookalike;
      if (id === moduleId && ["different-module", "different-both", "bad-hash"].includes(mode))
        return lookalike;
      return starter;
    };
    if (path.endsWith("/manifest")) {
      await manifestGate;
      return route.fulfill({
        json: {
          publicationId,
          projectId: snapshot.projectId,
          sourceRevision: 4,
          assets: [
            [environmentId, "environment"],
            [moduleId, "model"],
            [crateId, "model"],
          ].map(([id, kind]) => ({
            id,
            kind,
            sha256: mode === "bad-hash" && id === moduleId ? sha(starter) : sha(bytesFor(id)),
            url: `/api/publications/${publicationId}/assets/${id}/bytes`,
          })),
        },
      });
    }
    if (path.endsWith("/bytes")) {
      const id = path.split("/").at(-2);
      requests.push(id);
      return route.fulfill({ contentType: "model/gltf-binary", body: bytesFor(id) });
    }
    return route.fulfill({ json: snapshot });
  });

  // Instrument the same Three.js module as the visitor before releasing the manifest.
  const componentPath = new URL("../visitor/ExhibitionCanvas.tsx", import.meta.url).pathname;
  const component = await page.request.get(`${origin}/@fs${componentPath}`);
  assert.ok(component.ok(), "Visitor component is served by the development server");
  const transformed = await component.text();
  const threePath = transformed.match(/import \* as THREE from "([^"]+)"/)?.[1];
  assert.ok(threePath, "Resolve the visitor's Three.js module");

  async function load(nextMode) {
    mode = nextMode;
    manifestGate = new Promise((resolve) => {
      releaseManifest = resolve;
    });
    await page.goto(`${origin}/p/${publicationId}`);
    await page.addScriptTag({
      type: "module",
      content: `import * as THREE from ${JSON.stringify(threePath)};
        window.roomTestThree = THREE;
        const add = THREE.Object3D.prototype.add;
        THREE.Object3D.prototype.add = function (...objects) {
          if (this.isScene) window.roomTestScene = this;
          return add.apply(this, objects);
        };`,
    });
    await page.waitForFunction(() => window.roomTestThree);
    releaseManifest();
    if (nextMode === "bad-hash") {
      await page.getByText("An exhibition asset could not be verified.").waitFor();
    } else {
      await page.getByRole("status").getByText("Exhibition ready").waitFor();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }
  }
  async function walls(originPoint, direction) {
    return page.evaluate(
      ({ originPoint, direction }) => {
        const THREE = window.roomTestThree;
        const scene = window.roomTestScene;
        scene.updateMatrixWorld(true);
        return new THREE.Raycaster(
          new THREE.Vector3(...originPoint),
          new THREE.Vector3(...direction),
          0,
          2,
        )
          .intersectObject(scene, true)
          .filter((hit) => hit.object.name.startsWith("Wall_"))
          .map((hit) => hit.object.name);
      },
      { originPoint, direction },
    );
  }

  await load("canonical");
  assert.deepEqual(await walls([4, 1.5, 0], [1, 0, 0]), [], "Environment-to-module doorway");
  assert.deepEqual(await walls([10, 1.5, 4], [0, 0, 1]), [], "Rotated module-to-module doorway");
  assert.ok((await walls([4, 1.5, 2], [1, 0, 0])).length > 0, "Door jamb remains");
  assert.ok((await walls([4, 2.8, 0], [1, 0, 0])).length > 0, "Door lintel remains");
  assert.ok((await walls([-4, 1.5, 0], [-1, 0, 0])).length > 0, "Exterior wall stays closed");
  assert.ok(requests.includes(environmentId) && requests.includes(moduleId));
  const opened = await page.locator("canvas[aria-label='Exhibition view']").screenshot();

  await page.evaluate(() => {
    const roots = window.roomTestScene.children.filter((node) => node.isGroup);
    const mesh = roots[0].getObjectByName("Wall_Right");
    window.roomTestOpening = mesh.geometry;
    window.roomTestMesh = mesh;
    window.roomTestDisposed = false;
    mesh.geometry.addEventListener("dispose", () => (window.roomTestDisposed = true));
  });
  const firstCanvas = await page.locator("canvas[aria-label='Exhibition view']").elementHandle();
  await page.getByRole("combobox").selectOption("1");
  await page.waitForFunction((canvas) => !canvas.isConnected, firstCanvas);
  await page.getByRole("status").getByText("Exhibition ready").waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.ok((await walls([4, 1.5, 0], [1, 0, 0])).length > 0);
  assert.deepEqual(
    await page.evaluate(
      () => window.roomTestDisposed && window.roomTestMesh.geometry !== window.roomTestOpening,
    ),
    true,
    "Scene replacement restores the wall and disposes its doorway geometry",
  );

  for (const nextMode of ["different-module", "different-environment", "different-both"]) {
    await load(nextMode);
    assert.ok((await walls([4, 1.5, 0], [1, 0, 0])).length > 0, `${nextMode} stays closed`);
    if (nextMode === "different-both") {
      assert.ok((await walls([10, 1.5, 4], [0, 0, 1])).length > 0);
      assert.notDeepEqual(
        await page.locator("canvas[aria-label='Exhibition view']").screenshot(),
        opened,
        "The doorway changes the visible rendered view",
      );
    }
  }
  await load("bad-hash");
  assert.equal(await page.locator("canvas[aria-label='Exhibition view']").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log("Visitor adjoining-room rendering checks passed.");
} catch (error) {
  console.error(await page?.locator("body").innerText(), errors);
  throw error;
} finally {
  await browser.close();
}
