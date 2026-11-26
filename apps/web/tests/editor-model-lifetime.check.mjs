import assert from "node:assert/strict";
import { createServer } from "vite";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
const fixture = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const server = await createServer({
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    watch: { ignored: ["**/graphics/scene.ts", "**/asset-runtime/ModelCache.ts"] },
  },
  plugins: [
    {
      name: "lifecycle-host",
      configureServer(v) {
        v.middlewares.use("/lifecycle.html", (_, r) => {
          r.setHeader("Content-Type", "text/html");
          r.end('<div id="host" style="width:800px;height:600px"></div>');
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const target = `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL("lifecycle.html", target).href);
  const result = await page.evaluate(async (fixture) => {
    const { THREE, initScene, assets, ModelCache } = await import("/graphics/lifecycle-check.mjs");
    const ids = [
      "test-crate-v1",
      "display-cube-v1",
      "display-square-stand-v1",
      "display-rectangle-stand-v1",
      "display-square-panel-v1",
      "display-rectangle-panel-v1",
    ];
    const selected = ids.map((id) => {
      const a = assets.find((x) => x.id === id);
      if (!a) throw Error("missing " + id);
      return { ...a, thumbnail: "/provided.png" };
    });
    const cache = new ModelCache(),
      acquire = cache.acquire.bind(cache);
    let acquired = 0,
      released = 0,
      disposed = 0;
    const resources = new Set();
    cache.acquire = async (...args) => {
      const lease = await acquire(...args);
      acquired++;
      lease.value.model.traverse((node) => {
        if (node.geometry && !resources.has(node.geometry)) {
          resources.add(node.geometry);
          node.geometry.addEventListener("dispose", () => disposed++);
        }
      });
      return {
        value: lease.value,
        release() {
          released++;
          lease.release();
        },
      };
    };
    let renderer;
    Object.defineProperty(THREE.WebGLRenderer.prototype, "render", {
      configurable: true,
      set(fn) {
        renderer = this;
        Object.defineProperty(this, "render", { value: fn, writable: true, configurable: true });
      },
    });
    let resolve;
    const ready = new Promise((r) => (resolve = r));
    const handle = initScene(
      document.querySelector("#host"),
      selected,
      {
        onStatus(s) {
          if (s !== "loading") resolve(s);
        },
        onThumbnail() {},
        onSelect() {},
        onTransform() {},
        onObjectClick() {},
        onUpdate() {},
      },
      cache,
    );
    if ((await ready) !== "ready") throw Error("init failed");
    const scene = {
      ...fixture.scenes[0],
      environmentAssetId: null,
      objects: [],
      hotspots: [],
      interactions: [],
    };
    handle.update([], null, scene);
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const snap = () => ({
      acquired,
      released,
      disposed,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      geometryResources: resources.size,
    });
    const stages = [];
    for (const id of ids) {
      if (!(await handle.prepareAsset(id))) throw Error("failed " + id);
      if (!handle.showPlacementPreview(id, [0, 0, 0])) throw Error("preview failed " + id);
      await frames();
      handle.showPlacementPreview(undefined, undefined);
      await frames();
      stages.push({ id, ...snap() });
    }
    await new Promise((r) => setTimeout(r, 31000));
    const afterIdle = snap();
    const preparedAgain = await handle.prepareAsset(ids[0]);
    const previewAgain = handle.showPlacementPreview(ids[0], [0, 0, 0]);
    await frames();
    handle.dispose();
    await new Promise((r) => setTimeout(r, 1000));
    const afterUnmount = snap();
    cache.invalidate();
    await new Promise((r) => setTimeout(r, 100));
    return {
      stages,
      afterIdle,
      preparedAgain,
      previewAgain,
      afterUnmount,
      afterInvalidate: snap(),
    };
  }, fixture);
  console.log(JSON.stringify({ result, errors }));
  assert.deepEqual(errors, []);
  assert.equal(result.afterIdle.acquired, 6, "all six real models loaded");
  assert.ok(
    result.afterIdle.disposed > 0,
    "unused preview geometry is released after the cache idle period",
  );
  assert.equal(result.preparedAgain, true, "an evicted model can be prepared again");
  assert.equal(result.previewAgain, true, "the reused model produces a placement preview");
  assert.equal(
    result.afterUnmount.released,
    result.afterUnmount.acquired,
    "viewport releases its leases",
  );
} finally {
  await browser?.close();
  await server.close();
}
