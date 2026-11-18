import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Check real GLB revalidation before Playwright routing disables the HTTP cache.
  await page.goto(new URL("/", url).href);
  const transfers = await page.evaluate(async () => {
    const source = await (await fetch("/graphics/scene.ts")).text();
    const cachePath = source.match(/from "([^"]*ModelCache[^\"]*)"/)[1];
    const { ModelCache } = await import(cachePath);
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const asset = assets.find((asset) => asset.id === "test-crate-v1");
    const cache = new ModelCache();
    const url = new URL(asset.url, location.href).href;
    performance.clearResourceTimings();
    for (let request = 0; request < 2; request++) {
      const lease = await cache.acquire(asset, new AbortController().signal);
      try {
        if (lease.value.model.children.length === 0)
          throw new Error("GLB cache probe did not load the real model");
      } finally {
        lease.release();
        cache.invalidate();
      }
    }
    return performance
      .getEntriesByName(url, "resource")
      .map(({ transferSize, encodedBodySize }) => ({
        transferSize,
        encodedBodySize,
      }));
  });
  assert.equal(transfers.length, 2, "Invalidating the parsed model must fetch its URL twice");
  const [first, reload] = transfers;
  assert.ok(
    first.encodedBodySize > 300 && first.transferSize >= first.encodedBodySize,
    "The cold load must transfer the GLB body",
  );
  assert.equal(reload.encodedBodySize, first.encodedBodySize);
  // A local hit transfers zero bytes; HTTP 304 transfers just the response headers.
  assert.ok(
    reload.transferSize <= 300,
    `Reloading an invalidated model must reuse cached GLB bytes: ${JSON.stringify(transfers)}`,
  );
  await page.route("**/caching-harness.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main></main>",
    }),
  );
  await page.goto(new URL("caching-harness.html", url).href);
  const crateBytes = readFileSync(
    new URL("../../../assets/delivery/test-crate.glb", import.meta.url),
  );
  const vertices = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const bufferRequested = Promise.withResolvers();
  const releaseBuffer = Promise.withResolvers();
  let failure;
  let fetches = 0;
  let lateRequests = 0;
  await page.route(/\.glb(?:\?|$)/, async (route) => {
    if (route.request().resourceType() !== "fetch") {
      await route.continue();
      return;
    }
    fetches++;
    const request = new URL(route.request().url());
    if (request.pathname === "/cache-controlled.glb") {
      if (++lateRequests > 1) {
        await route.fulfill({ body: crateBytes, contentType: "model/gltf-binary" });
        return;
      }
      await route.fulfill({
        json: {
          asset: { version: "2.0" },
          scene: 0,
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [
            {
              primitives: [
                { attributes: { POSITION: 0 }, material: 0, extras: { lateCache: true } },
              ],
            },
          ],
          materials: [{ name: "LateCacheMaterial" }],
          accessors: [
            {
              bufferView: 0,
              componentType: 5126,
              count: 3,
              type: "VEC3",
              min: [0, 0, 0],
              max: [1, 1, 0],
            },
          ],
          bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }],
          buffers: [
            {
              uri: new URL("/cache-controlled.bin", request).href,
              byteLength: vertices.byteLength,
            },
          ],
        },
      });
      return;
    }
    if (failure === "http") await route.fulfill({ status: 503, body: "Unavailable" });
    else if (failure === "parse") await route.fulfill({ body: Buffer.alloc(20) });
    else await route.continue();
  });
  await page.route("**/cache-controlled.bin", async (route) => {
    bufferRequested.resolve();
    await releaseBuffer.promise;
    await route.fulfill({ body: vertices });
  });
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Profiler.enable");
  await devtools.send("Profiler.startPreciseCoverage", { callCount: true });
  let parses = 0;
  await page.exposeFunction("cacheTraffic", async () => {
    const { result } = await devtools.send("Profiler.takePreciseCoverage");
    for (const script of result) {
      for (const fn of script.functions) {
        if (fn.functionName === "parseAsync") parses += fn.ranges[0].count;
      }
    }
    return { fetches, parses };
  });
  await page.exposeFunction("cacheFailure", (kind) => {
    failure = kind;
  });
  await page.exposeFunction("cacheBufferRequested", () => bufferRequested.promise);
  await page.exposeFunction("releaseCacheBuffer", () => releaseBuffer.resolve());
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const result = await page.evaluate(async (fixture) => {
    const source = await (await fetch("/graphics/scene.ts")).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const cachePath = source.match(/from "([^"]*ModelCache[^\"]*)"/)[1];
    check(
      cachePath.includes("/shared/asset-runtime/"),
      "The renderer must load the shared asset-runtime module",
    );
    const { ModelCache } = await import(cachePath);
    const { initScene } = await import("/graphics/scene.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    function check(condition, message) {
      if (!condition) throw new Error(message);
    }
    let generatedThumbnails = 0;
    const originalImage = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      generatedThumbnails++;
      return originalImage.apply(this, args);
    };
    // Keep the load-count fixture fixed when the production catalogue gains more assets
    const fixtureIds = new Set(["test-room-v1", "test-crate-v1", "sample-snowglobe-v1"]);
    const libraryFixture = assets.filter((asset) => fixtureIds.has(asset.id));
    check(libraryFixture.length === fixtureIds.size, "Caching fixture assets are missing");

    function start(cache, library = libraryFixture) {
      const host = document.createElement("div");
      host.style.cssText = "width:800px;height:600px;position:relative";
      document.querySelector("main").append(host);
      const { promise, resolve } = Promise.withResolvers();
      const statuses = [];
      const thumbnails = [];
      let scene;
      const observeScene = ({ target }) => {
        if (target.background?.isColor) scene = target;
      };
      THREE.Scene.prototype.addEventListener("childadded", observeScene);
      let handle;
      try {
        handle = initScene(
          host,
          library,
          {
            onStatus(status) {
              statuses.push(status);
              if (status !== "loading") resolve(status);
            },
            onThumbnail(id, data) {
              thumbnails.push({ id, data });
            },
            onSelect() {},
            onTransform() {
              throw new Error("Cache changed authored data");
            },
          },
          cache,
        );
      } finally {
        THREE.Scene.prototype.removeEventListener("childadded", observeScene);
      }
      check(handle !== undefined, "WebGL unavailable");
      // This cache fixture intentionally exercises every fixture model; the editor itself loads on demand.
      for (const asset of library) void handle.prepareAsset(asset.id);
      return {
        handle,
        scene,
        host,
        statuses,
        thumbnails,
        ready: promise,
        dispose() {
          handle.dispose();
          handle.dispose();
          check(host.querySelectorAll("canvas").length === 0, "Canvas leak");
          host.remove();
        },
      };
    }
    function observe(model) {
      const resources = new Set();
      const images = new Set();
      const disposals = new Map();
      model.traverse((node) => {
        if (!node.isMesh) return;
        resources.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          resources.add(material);
          for (const value of Object.values(material))
            if (value?.isTexture) {
              resources.add(value);
              if (value.source.data instanceof ImageBitmap) images.add(value.source.data);
            }
        }
      });
      for (const resource of resources) {
        disposals.set(resource, 0);
        resource.addEventListener("dispose", () =>
          disposals.set(resource, disposals.get(resource) + 1),
        );
      }
      let closed = 0;
      for (const image of images) {
        const close = image.close.bind(image);
        image.close = () => {
          closed++;
          close();
        };
      }
      return {
        untouched: () => [...disposals.values()].every((n) => n === 0) && closed === 0,
        disposed: () => [...disposals.values()].every((n) => n === 1) && closed === images.size,
        resourceCount: resources.size,
        imageCount: images.size,
      };
    }
    const cache = new ModelCache();
    const snowglobe = assets.find((asset) => asset.id === "sample-snowglobe-v1");
    const originalFixture = JSON.stringify(fixture);
    const a = start(cache);
    const b = start(cache);
    check((await a.ready) === "ready" && (await b.ready) === "ready", "Concurrent startup failed");
    const concurrent = await window.cacheTraffic();
    check(
      concurrent.fetches === 3 && concurrent.parses === 3 && generatedThumbnails === 1,
      `Expected 3 fetches, 3 parses and 1 thumbnail; observed ${concurrent.fetches}, ${concurrent.parses} and ${generatedThumbnails}`,
    );
    check(a.thumbnails[0].data === b.thumbnails[0].data, "Cached thumbnail differs");
    const probe = await cache.acquire(snowglobe, new AbortController().signal);
    const oldModel = probe.value.model;
    const oldResources = observe(oldModel);
    probe.release();
    check(oldResources.imageCount > 0, "Real textured fixture required");
    const objects = [
      ...fixture.scenes[0].objects,
      {
        ...fixture.scenes[0].objects[1],
        id: "snowglobe-instance",
        assetId: snowglobe.id,
        transform: { position: [4, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    ];
    a.handle.update(objects, null, fixture.scenes[0]);
    b.handle.update(objects, null, fixture.scenes[0]);
    const bObject = b.scene.children.find((node) => node.isGroup && node.position.x === 4);
    const aObject = a.scene.children.find((node) => node.isGroup && node.position.x === 4);
    check(aObject !== bObject, "Transforms shared across viewports");
    aObject.position.x = 7;
    check(bObject.position.x === 4, "Borrowed transform mutated");
    a.dispose();
    check(oldResources.untouched(), "Disposing one viewport destroyed shared resources");
    b.handle.update(objects, null, fixture.scenes[0]);
    cache.invalidate(snowglobe.id);
    check(oldResources.untouched(), "Invalidation destroyed active resources");
    const c = start(cache);
    check((await c.ready) === "ready", "Invalidation reload failed");
    const fresh = await cache.acquire(snowglobe, new AbortController().signal);
    check(fresh.value.model !== oldModel, "Invalidation reused old model");
    const newResources = observe(fresh.value.model);
    fresh.release();
    b.dispose();
    check(oldResources.disposed() && newResources.untouched(), "Old/new resource ownership failed");
    c.dispose();
    for (let i = 0; i < 12; i++) {
      const viewport = start(cache);
      check((await viewport.ready) === "ready", "Repeated recreation failed");
      viewport.handle.update(objects, null, fixture.scenes[0]);
      viewport.dispose();
    }
    const repeated = await window.cacheTraffic();
    check(
      repeated.fetches === 4 && repeated.parses === 4 && generatedThumbnails === 2,
      `Expected 4 fetches, 4 parses and 2 thumbnails; observed ${repeated.fetches}, ${repeated.parses} and ${generatedThumbnails}`,
    );
    cache.invalidate();
    cache.invalidate();
    check(newResources.disposed(), "Cache teardown leaked/double-disposed resources");
    check(JSON.stringify(fixture) === originalFixture, "Authored fixture changed");

    const crate = assets.filter((asset) => asset.id === "test-crate-v1");
    for (const injected of ["http", "parse"]) {
      const retryCache = new ModelCache();
      await window.cacheFailure(injected);
      const failed = start(retryCache, crate);
      check((await failed.ready) === "error", "Injected failure not reported");
      failed.dispose();
      await window.cacheFailure(null);
      const retry = start(retryCache, crate);
      check((await retry.ready) === "ready", "Failed entry poisoned retry");
      retry.dispose();
      retryCache.invalidate();
    }

    const lateCache = new ModelCache();
    const delayedCrate = crate.map((asset) => ({ ...asset, url: "/cache-controlled.glb" }));
    const { promise: reclaimed, resolve: finishReclaiming } = Promise.withResolvers();
    let geometryDisposals = 0;
    let materialDisposals = 0;
    const checkDisposals = () => {
      if (geometryDisposals && materialDisposals) finishReclaiming();
    };
    const geometryDisposed = ({ target }) => {
      if (target.userData.lateCache) geometryDisposals++;
      checkDisposals();
    };
    const materialDisposed = ({ target }) => {
      if (target.name === "LateCacheMaterial") materialDisposals++;
      checkDisposals();
    };
    try {
      const stale = start(lateCache, delayedCrate);
      await window.cacheBufferRequested();
      stale.dispose();
      const replacement = start(lateCache, delayedCrate);
      check((await replacement.ready) === "ready", "Replacement failed");
      THREE.BufferGeometry.prototype.addEventListener("dispose", geometryDisposed);
      THREE.Material.prototype.addEventListener("dispose", materialDisposed);
      await window.releaseCacheBuffer();
      const signal = AbortSignal.timeout(5000);
      await Promise.race([
        reclaimed,
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Late parse leaked")), {
            once: true,
          });
        }),
      ]);
      check(
        geometryDisposals === 1 && materialDisposals === 1,
        "Late resources must be disposed once",
      );
      check(
        stale.statuses.every((status) => status === "loading") && stale.thumbnails.length === 0,
        "Stale result reached disposed viewport",
      );
      replacement.dispose();
    } finally {
      await window.releaseCacheBuffer();
      THREE.BufferGeometry.prototype.removeEventListener("dispose", geometryDisposed);
      THREE.Material.prototype.removeEventListener("dispose", materialDisposed);
      lateCache.invalidate();
    }
    check(document.querySelectorAll("canvas").length === 0, "Repeated disposal leaked canvases");
    return {
      concurrentFetches: 3,
      concurrentParses: 3,
      recreations: 12,
      sharedResourceCount: oldResources.resourceCount,
      sharedImageCount: oldResources.imageCount,
      retries: ["HTTP 503", "invalid GLB"],
      staleResultDiscarded: true,
    };
  }, fixture);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: concurrent loading, immutable transforms, cross-viewport ownership, invalidation, repeated teardown, failure/retry and stale parse cleanup",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
