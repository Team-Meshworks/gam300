import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/caching-harness.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main></main>",
    }),
  );
  await page.goto(new URL("caching-harness.html", url).href);
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const result = await page.evaluate(async (fixture) => {
    const source = await (await fetch("/graphics/scene.ts")).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const cachePath = source.match(/from "([^"]*ModelCache[^\"]*)"/)[1];
    const { ModelCache } = await import(cachePath);
    const cacheSource = await (await fetch(cachePath)).text();
    const { GLTFLoader } = await import(
      cacheSource.match(/import \{ GLTFLoader \} from "([^"]+)"/)[1]
    );
    const { initScene } = await import("/graphics/scene.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    function check(condition, message) {
      if (!condition) throw new Error(message);
    }
    const originalFetch = window.fetch;
    const originalParse = GLTFLoader.prototype.parseAsync;
    const counts = { fetches: 0, parses: 0, generatedThumbnails: 0 };
    let failure;
    window.fetch = function (url, ...args) {
      const isModel = String(url).split("?")[0].endsWith(".glb");
      if (isModel) counts.fetches++;
      if (isModel && failure === "http")
        return Promise.resolve(new Response("Unavailable", { status: 503 }));
      if (isModel && failure === "parse") return Promise.resolve(new Response(new Uint8Array(20)));
      return originalFetch.call(this, url, ...args);
    };
    GLTFLoader.prototype.parseAsync = function (...args) {
      counts.parses++;
      return originalParse.apply(this, args);
    };
    const originalImage = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      counts.generatedThumbnails++;
      return originalImage.apply(this, args);
    };
    function start(cache, library = assets) {
      const host = document.createElement("div");
      host.style.cssText = "width:800px;height:600px;position:relative";
      document.querySelector("main").append(host);
      const { promise, resolve } = Promise.withResolvers();
      const statuses = [];
      const thumbnails = [];
      const originalAdd = THREE.Object3D.prototype.add;
      let scene;
      THREE.Object3D.prototype.add = function (...nodes) {
        if (this.isScene && this.background?.isColor) scene = this;
        return originalAdd.apply(this, nodes);
      };
      let handle;
      try {
        handle = initScene(
          host,
          library,
          {
            onStatus(status) {
              statuses.push(status);
              resolve(status);
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
        THREE.Object3D.prototype.add = originalAdd;
      }
      check(handle !== undefined, "WebGL unavailable");
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
    check(
      counts.fetches === 3 && counts.parses === 3 && counts.generatedThumbnails === 1,
      "Concurrent loads/thumbnails duplicated",
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
    check(
      counts.fetches === 4 && counts.parses === 4 && counts.generatedThumbnails === 2,
      "Recreation reloaded immutable resources",
    );
    cache.invalidate();
    cache.invalidate();
    check(newResources.disposed(), "Cache teardown leaked/double-disposed resources");
    check(JSON.stringify(fixture) === originalFixture, "Authored fixture changed");

    const crate = assets.filter((asset) => asset.id === "test-crate-v1");
    for (const injected of ["http", "parse"]) {
      const retryCache = new ModelCache();
      failure = injected;
      const failed = start(retryCache, crate);
      check((await failed.ready) === "error", "Injected failure not reported");
      failed.dispose();
      failure = undefined;
      const retry = start(retryCache, crate);
      check((await retry.ready) === "ready", "Failed entry poisoned retry");
      retry.dispose();
      retryCache.invalidate();
    }

    const lateCache = new ModelCache();
    const { promise: parsed, resolve: finishParsing } = Promise.withResolvers();
    const { promise: gate, resolve: releaseLate } = Promise.withResolvers();
    let delayedResources;
    GLTFLoader.prototype.parseAsync = async function (...args) {
      const gltf = await originalParse.apply(this, args);
      delayedResources = observe(gltf.scene);
      finishParsing();
      await gate;
      return gltf;
    };
    const stale = start(lateCache, crate);
    await parsed;
    stale.dispose();
    GLTFLoader.prototype.parseAsync = originalParse;
    const replacement = start(lateCache, crate);
    check((await replacement.ready) === "ready", "Replacement failed");
    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check(delayedResources.disposed(), "Late parse leaked");
    check(
      stale.statuses.length === 0 && stale.thumbnails.length === 0,
      "Stale result reached disposed viewport",
    );
    replacement.dispose();
    lateCache.invalidate();
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
