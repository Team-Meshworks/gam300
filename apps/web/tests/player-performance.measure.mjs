import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { blankProject } from "./authoring-project-fixture.mjs";

// Run from apps/web: node tests/player-performance.measure.mjs [label]
// Results are local observations, not a pass/fail frame-rate threshold. Run baseline and
// candidate on the same machine, with no other benchmarks running. Save a baseline by
// copying shared/player/* and shared/asset-runtime/ModelCache.ts into the ignored
// test-results/player-baseline-source directory before edits, then set PLAYER_BASELINE=1.
// Set PLAYER_GOLDEN to the baseline stationary.png for an exact canvas comparison.
// --verify asserts deduplication, independent rendered instances and visit resource plateau.
// --sustained performs 40 returns with CDP heap/task/GC tracing; it is not a timing run.
// Visibility is simulated through the document.hidden handler, not real background throttling.
const verify = process.argv.includes("--verify");
const sustained = process.argv.includes("--sustained");
const label = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "run";
assert.match(label, /^[\w-]+$/);
const out = `test-results/player-performance-${label}`;
await mkdir(out, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseline = process.env.PLAYER_BASELINE === "1";
const source = await readFile(
  new URL(
    baseline
      ? "../test-results/player-baseline-source/ExhibitionCanvas.tsx"
      : "../shared/player/ExhibitionCanvas.tsx",
    import.meta.url,
  ),
);
const room = await readFile(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
const model = await readFile(new URL("../../../assets/delivery/snowglobe.glb", import.meta.url));
const pub = "11111111-1111-4111-8111-111111111111";
const env = "22222222-2222-4222-8222-222222222222";
const moduleId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const id = (n) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
const object = (n, assetId, position, scale = 1) => ({
  id: id(n),
  name: `Object ${n}`,
  assetId,
  transform: { position, rotation: [0, 0, 0, 1], scale: [scale, scale, scale] },
  visible: true,
  parentId: null,
  components: [],
});
const base = structuredClone(blankProject.scenes[0]);
Object.assign(base, {
  environmentAssetId: env,
  startCamera: {
    position: [0, 1.5, 0],
    rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
    fovDegrees: 40,
  },
  objects: [
    ...Array.from({ length: 8 }, (_, i) => object(i + 1, moduleId, [(i + 1) * 10, 0, 0])),
    ...Array.from({ length: 12 }, (_, i) =>
      object(i + 20, modelId, [3 + (i % 4) * 1.4, 0.8, -2 + Math.floor(i / 4) * 1.4], 0.5),
    ),
  ],
});
const second = {
  ...structuredClone(base),
  id: id(100),
  name: "Second scene",
  objects: base.objects
    .slice(8, 12)
    .map((entry, i) => ({ ...structuredClone(entry), id: id(110 + i), components: [] })),
};
const view = id(101);
second.viewpoints = [{ id: view, name: "Entrance", camera: second.startCamera }];
base.objects[8].components.push({
  id: id(102),
  type: "navigationPoint",
  label: "Enter second scene",
  sceneId: second.id,
  viewpointId: view,
});
const back = id(103);
base.viewpoints = [{ id: back, name: "Entrance", camera: base.startCamera }];
second.objects[0].components.push({
  id: id(104),
  type: "navigationPoint",
  label: "Return to first scene",
  sceneId: base.id,
  viewpointId: back,
});
const project = { ...blankProject, scenes: [base, second] };
const assets = [
  [env, "environment", room],
  [moduleId, "model", room],
  [modelId, "model", model],
];
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    watch: { ignored: ["**/shared/player/**", "**/shared/asset-runtime/ModelCache.ts"] },
  },
  plugins: [
    {
      name: "player-measure-hook",
      enforce: "pre",
      async transform(code, path) {
        const normalized = path.replaceAll("\\", "/");
        if (baseline && normalized.endsWith("/shared/asset-runtime/ModelCache.ts"))
          return {
            code: await readFile(
              new URL("../test-results/player-baseline-source/ModelCache.ts", import.meta.url),
              "utf8",
            ),
            map: null,
          };
        if (baseline && normalized.includes("/shared/player/")) {
          const name = normalized.split("/shared/player/")[1];
          code = await readFile(
            new URL(`../test-results/player-baseline-source/${name}`, import.meta.url),
            "utf8",
          );
        }
        if (!normalized.endsWith("/shared/player/ExhibitionCanvas.tsx"))
          return baseline && normalized.includes("/shared/player/")
            ? { code, map: null }
            : undefined;
        const needle = "renderer.setPixelRatio(";
        assert.ok(code.includes(needle), "renderer instrumentation anchor changed");
        return {
          code: code.replace(needle, "window.__playerMeasure.attach(renderer);\n    " + needle),
          map: null,
        };
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  const warnings = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) warnings.push(m.text());
  });
  await page.addInitScript(() => {
    const m = (window.__playerMeasure = {
      active: false,
      frames: [],
      cpu: [],
      infos: [],
      renderers: [],
      seen: new WeakSet(),
      last: 0,
      parses: 0,
      ray: [],
      attach(renderer) {
        if (m.seen.has(renderer)) return;
        m.seen.add(renderer);
        const render = renderer.render.bind(renderer);
        const dispose = renderer.dispose.bind(renderer);
        const record = { disposed: false };
        m.renderers.push(record);
        const gl = renderer.getContext(),
          ext = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
          pending = [];
        record.gpuTimer = ext ? "available" : "unavailable";
        m.gpu = [];
        function poll() {
          while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
            const query = pending.shift();
            if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && m.active)
              m.gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(query);
          }
        }
        renderer.dispose = () => {
          for (const query of pending) gl.deleteQuery(query);
          dispose();
          record.disposed = true;
          record.afterDispose = {
            ...renderer.info.memory,
            programs: renderer.info.programs?.length,
          };
        };
        renderer.render = (scene, camera) => {
          if (ext) poll();
          const query = ext && m.active && pending.length < 8 ? gl.createQuery() : null;
          if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          const before = performance.now();
          render(scene, camera);
          const after = performance.now();
          if (query) {
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            pending.push(query);
          }
          if (m.active) {
            if (m.last) m.frames.push(before - m.last);
            m.last = before;
            m.cpu.push(after - before);
            m.infos.push({
              calls: renderer.info.render.calls,
              triangles: renderer.info.render.triangles,
              ...renderer.info.memory,
              programs: renderer.info.programs?.length,
            });
          }
          m.camera = camera.position.toArray();
          m.rotation = camera.quaternion.toArray();
          m.scene = scene;
          m.latest = { ...renderer.info.memory };
        };
      },
    });
  });
  let release;
  let gate = new Promise((resolve) => (release = resolve));
  await page.route("**/api/v1/publications/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/manifest")) {
      await gate;
      return route.fulfill({
        json: {
          publicationId: pub,
          projectId: project.projectId,
          sourceRevision: 1,
          assets: assets.map(([id, kind, bytes]) => ({
            id,
            kind,
            sha256: sha(bytes),
            url: `/api/v1/publications/${pub}/assets/${id}/bytes`,
          })),
        },
      });
    }
    if (path.endsWith("/bytes")) {
      const assetId = path.split("/").at(-2);
      requests.push(assetId);
      return route.fulfill({
        contentType: "model/gltf-binary",
        body: assets.find((row) => row[0] === assetId)[2],
      });
    }
    return route.fulfill({ json: project });
  });
  const componentPath = new URL("../shared/player/ExhibitionCanvas.tsx", import.meta.url).pathname;
  const transformed = await (await page.request.get(`${origin}/@fs${componentPath}`)).text();
  const threePath = transformed.match(/import \* as THREE from "([^"]+)"/)?.[1];
  const cachePath = new URL("../shared/asset-runtime/ModelCache.ts", import.meta.url).pathname;
  const cacheTransformed = await (await page.request.get(`${origin}/@fs${cachePath}`)).text();
  const loaderPath = (
    transformed.match(/import \{ GLTFLoader \} from "([^"]+)"/) ??
    cacheTransformed.match(/import \{ GLTFLoader \} from "([^"]+)"/)
  )?.[1];
  assert.ok(threePath && loaderPath, "resolve exact Three and loader modules");
  const start = Date.now();
  await page.goto(`${origin}/p/${pub}`);
  await page.addScriptTag({
    type: "module",
    content: `import * as THREE from ${JSON.stringify(threePath)}; import {GLTFLoader} from ${JSON.stringify(loaderPath)};
    const parse=GLTFLoader.prototype.parse; GLTFLoader.prototype.parse=function(...args){window.__playerMeasure.parses++; return parse.apply(this,args)};
    const intersect=THREE.Raycaster.prototype.intersectObjects; THREE.Raycaster.prototype.intersectObjects=function(...args){const t=performance.now();try{return intersect.apply(this,args)}finally{if(window.__playerMeasure.active)window.__playerMeasure.ray.push(performance.now()-t)}};
    window.__measureReady=true;`,
  });
  await page.waitForFunction(() => window.__measureReady);
  release();
  await page
    .getByRole("status")
    .getByText("Exhibition ready")
    .waitFor({ timeout: 20000 })
    .catch(async (e) => {
      console.error(
        "BODY",
        await page.locator("body").innerText(),
        "ERRORS",
        errors,
        "WARNINGS",
        warnings,
      );
      throw e;
    });
  const readyMs = Date.now() - start;
  if (verify) {
    const observed = await page.evaluate(
      (ids) => {
        const m = window.__playerMeasure;
        const roots = ids.map((id) => m.scene.getObjectByName(id));
        return {
          parses: m.parses,
          camera: m.camera,
          canvases: document.querySelectorAll("canvas").length,
          roots: roots.filter(Boolean).length,
          distinct: new Set(roots).size,
          meshes: roots.reduce((n, root) => {
            root?.traverse((node) => {
              if (node.isMesh) n++;
            });
            return n;
          }, 0),
        };
      },
      Array.from({ length: 12 }, (_, i) => id(i + 20)),
    );
    console.log(
      JSON.stringify({
        requests: requests.length,
        uniqueAssets: new Set(requests).size,
        ...observed,
      }),
    );
    assert.equal(observed.canvases, 1, "visible player canvas");
    assert.equal(observed.camera.length, 3, "camera rendered");
    assert.equal(observed.roots, 12, "all authored models exist");
    assert.equal(observed.distinct, 12, "model roots are independent");
    assert.ok(observed.meshes >= 12, "models contain visible geometry");
    assert.equal(requests.length, 3, "one fetch per unique asset in scene");
    assert.equal(observed.parses, 3, "one parse per unique asset in scene");
  }
  await page.waitForTimeout(2000);
  const device = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const timer = gl?.getExtension("EXT_disjoint_timer_query_webgl2");
    return {
      userAgent: navigator.userAgent,
      dpr: devicePixelRatio,
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
      gpuTimer: timer ? "available (nonblocking queries)" : "unavailable",
    };
  });
  const samples = [];
  async function sample(name, exercise) {
    await page.evaluate(() => {
      const m = window.__playerMeasure;
      Object.assign(m, { active: true, frames: [], cpu: [], ray: [], gpu: [], infos: [], last: 0 });
    });
    await exercise();
    samples.push({
      name,
      ...(await page.evaluate(() => {
        const m = window.__playerMeasure;
        m.active = false;
        return {
          frames: m.frames,
          cpu: m.cpu,
          ray: m.ray,
          gpu: m.gpu,
          infos: m.infos,
          camera: m.camera,
          rotation: m.rotation,
          parses: m.parses,
          renderers: m.renderers,
        };
      })),
      requests: requests.length,
    });
  }
  await sample("stationary", () => page.waitForTimeout(5000));
  const screenshot = await page
    .locator('canvas[aria-label="Exhibition view"]')
    .screenshot({ path: out + "/stationary.png" });
  let visualComparison;
  if (process.env.PLAYER_GOLDEN) {
    const reference = await readFile(process.env.PLAYER_GOLDEN);
    visualComparison = await page.evaluate(
      async ([a, b]) => {
        async function pixels(base64) {
          const image = await createImageBitmap(
            await (await fetch("data:image/png;base64," + base64)).blob(),
          );
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return {
            width: image.width,
            height: image.height,
            data: ctx.getImageData(0, 0, image.width, image.height).data,
          };
        }
        const x = await pixels(a),
          y = await pixels(b);
        if (x.width !== y.width || x.height !== y.height) return { sameSize: false };
        let changed = 0,
          total = 0,
          max = 0;
        for (let i = 0; i < x.data.length; i += 4) {
          let d = 0;
          for (let j = 0; j < 3; j++) d = Math.max(d, Math.abs(x.data[i + j] - y.data[i + j]));
          if (d > 2) changed++;
          total += d;
          max = Math.max(max, d);
        }
        return {
          sameSize: true,
          pixels: x.width * x.height,
          changedOver2: changed,
          meanMaxChannelDifference: total / (x.width * x.height),
          maxChannelDifference: max,
        };
      },
      [reference.toString("base64"), screenshot.toString("base64")],
    );
  }
  await sample("walking-and-rotation", async () => {
    await page.mouse.move(480, 400);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.keyboard.up("Alt");
    await page.keyboard.down("w");
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(480 + (i % 2) * 180, 400, { steps: 4 });
      await page.waitForTimeout(500);
    }
    await page.keyboard.up("w");
    await page.mouse.up();
  });
  const visits = [];
  let sustainedMetrics;
  const cdp = sustained ? await context.newCDPSession(page) : null;
  const heapAtReturn = [];
  let traceCompleted;
  if (cdp) {
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const initialHeap = await cdp.send("Runtime.getHeapUsage");
    traceCompleted = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8",
      transferMode: "ReturnAsStream",
    });
    sustainedMetrics = { initialHeap };
  }
  async function navigate(name) {
    const started = performance.now(),
      beforeRequests = requests.length;
    const beforeParses = await page.evaluate(() => window.__playerMeasure.parses);
    const target = name === "Enter second scene" ? second.id : base.id;
    await page.locator(".visitor-information").evaluate((el) => (el.open = true));
    await page.getByRole("button", { name }).click();
    await page.waitForFunction(
      (id) =>
        document.querySelector("[data-exhibition-scene]")?.getAttribute("data-exhibition-scene") ===
        id,
      target,
    );
    await page.getByRole("status").getByText("Exhibition ready").waitFor({ timeout: 60000 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    visits.push({
      name,
      readyMs: performance.now() - started,
      requests: requests.length - beforeRequests,
      ...(await page.evaluate(() => ({
        parses: window.__playerMeasure.parses,
        info: window.__playerMeasure.latest,
      }))),
    });
    visits.at(-1).parses -= beforeParses;
    if (cdp && name === "Return to first scene") {
      const heap = await cdp.send("Runtime.getHeapUsage");
      const metrics = await cdp.send("Performance.getMetrics");
      heapAtReturn.push({
        heap,
        metrics: Object.fromEntries(
          metrics.metrics
            .filter((m) =>
              [
                "TaskDuration",
                "ScriptDuration",
                "JSHeapUsedSize",
                "Nodes",
                "JSEventListeners",
              ].includes(m.name),
            )
            .map((m) => [m.name, m.value]),
        ),
        info: visits.at(-1).info,
      });
    }
  }
  await sample("scene-navigation", async () => {
    for (let i = 0; i < (sustained ? 40 : 3); i++) {
      await navigate("Enter second scene");
      await navigate("Return to first scene");
    }
  });
  if (cdp) {
    await cdp.send("Tracing.end");
    const { stream } = await traceCompleted;
    let trace = "";
    for (;;) {
      const part = await cdp.send("IO.read", { handle: stream });
      trace += part.data;
      if (part.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    await writeFile(out + "/trace.json", trace);
    const events = JSON.parse(trace).traceEvents;
    const gc = events.filter(
      (event) => event.ph === "X" && /(?:MinorGC|MajorGC|V8\.GC)/.test(event.name),
    );
    const tasks = events.filter((event) => event.ph === "X" && event.name === "RunTask");
    await cdp.send("HeapProfiler.collectGarbage");
    sustainedMetrics = {
      ...sustainedMetrics,
      finalHeap: await cdp.send("Runtime.getHeapUsage"),
      heapAtReturn,
      gc: gc.map(({ name, ts, dur, pid, tid }) => ({ name, ts, dur, pid, tid })),
      tasks: tasks.map(({ ts, dur, pid, tid }) => ({ ts, dur, pid, tid })),
    };
    await cdp.detach();
  }
  if (verify) {
    const returns = visits.filter((v) => v.name === "Return to first scene");
    console.log(
      "return resource counts",
      returns.map((v) => v.info),
    );
    assert.deepEqual(
      returns.map((v) => v.info),
      Array(3).fill(returns[0].info),
      "resources plateau after repeated identical scene visits",
    );
  }
  // Exercise visibility handlers; this does not simulate browser background throttling.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sample("revisited-after-visibility", () => page.waitForTimeout(5000));
  const final = await page.evaluate(() => ({
    parses: window.__playerMeasure.parses,
    renderers: window.__playerMeasure.renderers,
    liveRenderers: window.__playerMeasure.renderers.filter((r) => !r.disposed).length,
  }));
  await page.goto("about:blank");
  await context.close();
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      max: sorted.at(-1),
      over50ms: sorted.filter((v) => v > 50).length,
    };
  };
  const summary = samples.map(({ name, frames, cpu, gpu, ray, infos, camera, rotation }) => ({
    name,
    frames: stats(frames),
    cpu: stats(cpu),
    gpu: stats(gpu),
    ray: stats(ray),
    info: infos.at(-1),
    camera,
    rotation,
  }));
  await writeFile(
    `${out}/results.json`,
    JSON.stringify(
      {
        label,
        sustainedMetrics,
        measuredAt: new Date().toISOString(),
        browser: browser.version(),
        device,
        conditions: {
          viewport: "1000x800",
          dpr: 1,
          sourceSha256: sha(source),
          roomSha256: sha(room),
          modelSha256: sha(model),
          warmupSeconds: 2,
          sampleSeconds: 5,
          network: "local intercepted publication API",
          roomCount: 9,
          modelCount: 12,
        },
        readyMs,
        requests,
        errors,
        warnings,
        summary,
        samples,
        visits,
        final,
        visualComparison,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      out,
      readyMs,
      requests: requests.length,
      parses: final.parses,
      errors,
      warnings,
      device,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
