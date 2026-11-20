import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const server = await createServer({
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "model-preparation-check",
      configureServer(vite) {
        vite.middlewares.use("/model-preparation-check.html", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><div id="host" style="width:800px;height:600px"></div>');
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const target = `http://127.0.0.1:${address.port}/`;
  browser = await launchBrowser({ target });
  for (const thumbnailMode of ["provided", "generated"]) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL("model-preparation-check.html", target).href);
    const result = await page.evaluate(
      async ({ fixture, thumbnailMode }) => {
        const source = await (await fetch("/graphics/scene.ts")).text();
        const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
        const cachePath = source.match(/from "([^"]*ModelCache[^\"]*)"/)[1];
        const cacheSource = await (await fetch(cachePath)).text();
        const { GLTFLoader } = await import(
          cacheSource.match(/import \{ GLTFLoader \} from "([^"]+)"/)[1]
        );
        const { initScene } = await import("/graphics/scene.ts");
        const { assets: catalogue } = await import("/@id/__x00__virtual:asset-catalogue");
        const assetId = "furniture-modern-bench-1-v1";
        const asset = catalogue.find((entry) => entry.id === assetId);
        if (!asset) throw new Error("Benchmark bench asset missing");
        const assets = catalogue.map((entry) =>
          entry.id === assetId
            ? { ...entry, thumbnail: thumbnailMode === "generated" ? null : "/provided.png" }
            : entry,
        );
        const counts = { uploads: 0, links: 0, fetches: 0, parses: 0, thumbnails: 0, captures: 0 };
        const uploadDetails = [];
        const canvasToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          counts.captures++;
          return canvasToDataURL.apply(this, args);
        };
        const glPrototype = WebGL2RenderingContext.prototype;
        for (const [method, key] of [
          ["texSubImage2D", "uploads"],
          ["linkProgram", "links"],
        ]) {
          const original = glPrototype[method];
          glPrototype[method] = function (...args) {
            counts[key]++;
            if (method === "texSubImage2D") {
              const image = args.at(-1);
              uploadDetails.push({
                phase,
                width: image?.width ?? args[4],
                height: image?.height ?? args[5],
              });
            }
            return original.apply(this, args);
          };
        }
        const originalFetch = window.fetch;
        window.fetch = function (url, ...args) {
          if (String(url).split("?")[0].endsWith(".glb")) counts.fetches++;
          return originalFetch.call(this, url, ...args);
        };
        const originalParse = GLTFLoader.prototype.parseAsync;
        GLTFLoader.prototype.parseAsync = function (...args) {
          counts.parses++;
          return originalParse.apply(this, args);
        };
        let phase = "setup";
        const draws = [];
        Object.defineProperty(THREE.WebGLRenderer.prototype, "render", {
          configurable: true,
          set(render) {
            Object.defineProperty(this, "render", {
              configurable: true,
              writable: true,
              value: function (scene, camera) {
                let texturedVisible = false;
                scene.traverseVisible((node) => {
                  if (!node.isMesh) return;
                  for (const material of Array.isArray(node.material)
                    ? node.material
                    : [node.material]) {
                    if (material.map?.isTexture && node.geometry?.attributes.position?.count > 0)
                      texturedVisible = true;
                  }
                });
                const ghost = scene.getObjectByName("placement-preview");
                const result = render.call(this, scene, camera);
                draws.push({
                  phase,
                  texturedVisible,
                  ghost: !!ghost?.visible,
                  triangles: this.info.render.triangles,
                });
                return result;
              },
            });
          },
        });
        let resolveStatus;
        const ready = new Promise((resolve) => {
          resolveStatus = resolve;
        });
        const handle = initScene(document.getElementById("host"), assets, {
          onStatus(status) {
            if (status !== "loading") resolveStatus(status);
          },
          onThumbnail(id, url) {
            if (id === assetId && url.startsWith("data:image/png")) counts.thumbnails++;
          },
          onSelect() {},
          onTransform() {},
        });
        if ((await ready) !== "ready") throw new Error("Editor did not initialize");
        const scene = {
          ...fixture.scenes[0],
          environmentAssetId: null,
          objects: [],
          hotspots: [],
          interactions: [],
        };
        handle.update([], null, scene);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const snapshot = () => ({ ...counts });
        const before = snapshot();
        phase = "prepare";
        const prepared = await handle.prepareAsset(assetId);
        const afterPrepare = snapshot();
        phase = "preview";
        const previewVisible = handle.showPlacementPreview(assetId, [0, 0, 0]);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const afterPreview = snapshot();
        phase = "placement";
        handle.showPlacementPreview(undefined, undefined);
        const object = {
          ...fixture.scenes[0].objects[0],
          id: "test-bench",
          assetId,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        };
        handle.update([object], null, { ...scene, objects: [object] });
        handle.locateObject(object.id);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const afterPlacement = snapshot();
        phase = "second";
        const object2 = {
          ...object,
          id: "test-bench-2",
          transform: { ...object.transform, position: [2, 0, 0] },
        };
        handle.update([object, object2], null, { ...scene, objects: [object, object2] });
        const secondReady = await handle.prepareAsset(assetId);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const afterSecond = snapshot();
        handle.dispose();
        return {
          prepared,
          previewVisible,
          secondReady,
          before,
          afterPrepare,
          afterPreview,
          afterPlacement,
          afterSecond,
          draws,
          uploadDetails,
        };
      },
      { fixture, thumbnailMode },
    );
    assert.deepEqual(errors, [], "No browser errors");
    assert.equal(result.prepared, true, "The real GLB must load");
    assert.equal(
      result.afterPrepare.thumbnails - result.before.thumbnails,
      thumbnailMode === "generated" ? 1 : 0,
      "Only the missing thumbnail is generated and returned",
    );
    assert.equal(
      result.afterPrepare.captures - result.before.captures,
      thumbnailMode === "generated" ? 1 : 0,
      "Only the missing thumbnail is captured",
    );
    assert.equal(result.previewVisible, true, "The placement preview must be shown");
    assert.ok(
      result.afterPrepare.fetches > result.before.fetches &&
        result.afterPrepare.parses > result.before.parses,
      "The cold GLB must be fetched and parsed",
    );
    assert.ok(
      result.draws.some(
        (draw) =>
          draw.phase === "preview" && draw.ghost && draw.texturedVisible && draw.triangles > 0,
      ),
      "Preview must draw a visible textured mesh",
    );
    assert.ok(
      result.draws.some(
        (draw) =>
          draw.phase === "placement" && !draw.ghost && draw.texturedVisible && draw.triangles > 0,
      ),
      "Placement must draw a visible textured mesh",
    );
    assert.ok(
      result.afterPrepare.uploads > result.before.uploads,
      `Preparation must upload actual model textures: ${JSON.stringify(result)}`,
    );
    assert.equal(
      result.uploadDetails.filter(
        (upload) => upload.phase === "preview" && Math.max(upload.width, upload.height) >= 512,
      ).length,
      0,
      `First preview must not upload bench textures: ${JSON.stringify(result.uploadDetails)}`,
    );
    assert.equal(
      result.afterPreview.links,
      result.afterPrepare.links,
      "First preview must use precompiled shader variants",
    );
    assert.equal(
      result.uploadDetails.filter(
        (upload) => upload.phase === "placement" && Math.max(upload.width, upload.height) >= 512,
      ).length,
      0,
      "First placement must not upload bench textures",
    );
    assert.equal(
      result.afterPlacement.links,
      result.afterPreview.links,
      "First placement must use precompiled shader variants",
    );
    assert.equal(result.secondReady, true);
    assert.equal(
      result.afterSecond.fetches,
      result.afterPlacement.fetches,
      "Second instance must reuse the fetched model",
    );
    assert.equal(
      result.afterSecond.parses,
      result.afterPlacement.parses,
      "Second instance must reuse the parsed model",
    );
    await page.close();
  }
  console.log("Model preparation browser regression passed (provided and generated thumbnails).");
} finally {
  await browser?.close();
  await server.close();
}
