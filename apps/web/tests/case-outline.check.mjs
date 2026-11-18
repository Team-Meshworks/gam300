import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";
const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5185/",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  const project = await serveProject(page, process.argv[2] ?? "http://127.0.0.1:5185/");
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const result = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const { initScene } = await import("/graphics/scene.ts");
    const { visibleModelBounds } = await import("/graphics/visible-model-bounds.ts");
    const asset = assets.find((asset) => asset.id === "display-full-glass-case-v1");
    const { Scene } = await import("/@id/three");
    let outline;
    const observeOutline = ({ child }) => {
      if (child.box?.isBox3 && child.isLineSegments) outline = child;
    };
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;width:800px;height:600px";
    document.body.append(host);
    let ready;
    const loaded = new Promise((resolve) => (ready = resolve));
    Scene.prototype.addEventListener("childadded", observeOutline);
    let renderer;
    try {
      renderer = initScene(host, assets, {
        onStatus: (status) => {
          if (status === "ready") ready();
        },
        onThumbnail() {},
        onSelect() {},
        onTransform() {},
        onObjectClick() {},
        onUpdate() {},
      });
    } finally {
      Scene.prototype.removeEventListener("childadded", observeOutline);
    }
    await loaded;
    const owner = {
      id: "case",
      assetId: asset.id,
      name: "Case",
      visible: true,
      parentId: null,
      transform: { position: [3, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [],
    };
    const child = {
      id: "object",
      assetId: "test-crate-v1",
      name: "Object",
      visible: true,
      parentId: owner.id,
      transform: { position: [3, 1.4, 2], rotation: [0, 0, 0, 1], scale: [0.15, 0.15, 0.15] },
      components: [],
    };
    await Promise.all([renderer.prepareAsset(owner.assetId), renderer.prepareAsset(child.assetId)]);
    renderer.update([owner, child], owner.id);
    const roots = outline.parent.children.filter(
      (node) =>
        node.isGroup && node.children[0]?.isGroup && node.position.x === 3 && node.position.z === 2,
    );
    const expected = roots.map(visibleModelBounds).reduce((box, next) => box.union(next));
    // Hidden covers cannot intercept either an object pick or hotspot placement on its visible exhibit
    renderer.showCamera({ position: [3, 1.475, 7], rotation: [0, 0, 0, 1], fovDegrees: 60 });
    const filled = {
      picked: renderer.pickObjectAt(400, 300),
      actual: [...outline.box.min.toArray(), ...outline.box.max.toArray()],
      expected: [...expected.min.toArray(), ...expected.max.toArray()],
      roots: roots.length,
    };
    renderer.update([owner], owner.id);
    const empty = outline.box.getSize(outline.box.min.clone()).toArray();
    renderer.dispose();
    host.remove();
    return { filled, empty };
  });
  assert.equal(
    result.filled.picked,
    "object",
    "Hidden glass does not cover the visible exhibit pick",
  );
  assert.equal(result.filled.roots, 2);
  result.filled.actual.forEach((value, index) =>
    assert.ok(Math.abs(value - result.filled.expected[index]) < 1e-6),
  );
  assert.ok(result.empty.every((value) => value > 0));
  console.log(
    "PASS: filled case outline tightly encloses visible case and displayed object; empty case still has valid bounds.",
  );
} finally {
  await browser.close();
}
