import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, normalizePath } from "vite";

// The unmodified renderer is loaded beside the candidate, with the same dependencies
const baselineRevision = "8f05c0719eb568d9522b2ab55166e4c46619c873";
const baselineSource = execFileSync(
  "git",
  ["show", `${baselineRevision}:web/editor/graphics/scene.ts`],
  { encoding: "utf8" },
);
const baselinePath = normalizePath(
  fileURLToPath(new URL("../editor/graphics/ti18-baseline.ts", import.meta.url)),
);
const fixture = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("../../assets/manifest.json", import.meta.url), "utf8"),
);
const runs = 16;
const missRuns = 8;
const output = process.argv[2] ?? "test-results/caching.json";
const server = await createServer({
  server: { host: "127.0.0.1", port: 5190, strictPort: true },
  plugins: [
    {
      name: "ti18-measurement-only",
      resolveId(id) {
        if (id === "/graphics/ti18-baseline.ts") return baselinePath;
      },
      load(id) {
        if (id === baselinePath) return baselineSource;
      },
      configureServer(server) {
        server.middlewares.use("/ti18-harness.html", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><div id="host" style="width:800px;height:600px"></div>');
        });
      },
    },
  ],
});
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
let browser;
const samples = [];
try {
  await server.listen();
  browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader"],
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  let browserDetails;
  for (const httpCache of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: !httpCache });
    let responses = [];
    cdp.on("Network.responseReceived", ({ response }) => {
      if (new URL(response.url).pathname.endsWith(".glb"))
        responses.push({
          status: response.status,
          diskCache: !!response.fromDiskCache,
          serviceWorker: !!response.fromServiceWorker,
        });
    });
    await page.goto("http://127.0.0.1:5190/ti18-harness.html");
    browserDetails = await page.evaluate(async () => {
      const source = await (await fetch("/graphics/ti18-baseline.ts")).text();
      const threePath = source.match(/import \* as THREE from "([^"]+)"/)[1];
      const loaderPath = source.match(/import \{ GLTFLoader \} from "([^"]+)"/)[1];
      const THREE = await import(threePath);
      const { GLTFLoader } = await import(loaderPath);
      const baseline = await import("/graphics/ti18-baseline.ts");
      const candidate = await import("/graphics/scene.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const originalFetch = window.fetch;
      const originalParse = GLTFLoader.prototype.parseAsync;
      const originalImage = HTMLCanvasElement.prototype.toDataURL;
      const counts = {
        fetches: 0,
        parses: 0,
        thumbnails: 0,
        fetchMs: 0,
        parseMs: 0,
        thumbnailEncodeMs: 0,
        renderMs: 0,
      };
      window.fetch = function (url, ...args) {
        if (!String(url).split("?")[0].endsWith(".glb"))
          return originalFetch.call(this, url, ...args);
        counts.fetches++;
        const started = performance.now();
        return originalFetch.call(this, url, ...args).finally(() => {
          counts.fetchMs += performance.now() - started;
        });
      };
      GLTFLoader.prototype.parseAsync = function (...args) {
        counts.parses++;
        const started = performance.now();
        return originalParse.apply(this, args).finally(() => {
          counts.parseMs += performance.now() - started;
        });
      };
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        counts.thumbnails++;
        const started = performance.now();
        try {
          return originalImage.apply(this, args);
        } finally {
          counts.thumbnailEncodeMs += performance.now() - started;
        }
      };
      // Three.js assigns render on each instance in its constructor
      Object.defineProperty(THREE.WebGLRenderer.prototype, "render", {
        configurable: true,
        set(render) {
          Object.defineProperty(this, "render", {
            configurable: true,
            writable: true,
            value: function (...args) {
              const started = performance.now();
              try {
                return render.apply(this, args);
              } finally {
                counts.renderMs += performance.now() - started;
              }
            },
          });
        },
      });
      window.measureViewport = async (version, fixture, invalidate) => {
        if (invalidate) candidate.editorModelCache?.invalidate();
        for (const key of Object.keys(counts)) counts[key] = 0;
        performance.clearResourceTimings();
        const started = performance.now();
        const { promise, resolve, reject } = Promise.withResolvers();
        const handle = (version === "baseline" ? baseline : candidate).initScene(
          document.getElementById("host"),
          assets,
          {
            onStatus(status) {
              if (status === "ready") resolve();
              else if (status === "error" || status === "unsupported") reject(new Error(status));
            },
            onThumbnail() {},
            onSelect() {},
            onTransform() {},
          },
        );
        handle.update(fixture.scenes[0].objects, null, fixture.scenes[0]);
        const setupMs = performance.now() - started;
        try {
          await promise;
          if (counts.renderMs === 0) throw new Error("Renderer timing probe missed render calls");
          return {
            readyMs: performance.now() - started,
            setupMs,
            ...counts,
            resources: performance
              .getEntriesByType("resource")
              .filter((entry) => new URL(entry.name).pathname.endsWith(".glb"))
              .map((entry) => ({
                transferBytes: entry.transferSize,
                decodedBytes: entry.decodedBodySize,
                durationMs: entry.duration,
              })),
          };
        } finally {
          handle.dispose();
          if (document.querySelectorAll("canvas").length !== 0) throw new Error("Canvas leaked");
        }
      };
      const gl = document.createElement("canvas").getContext("webgl2");
      const extension = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = extension
        ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      gl.getExtension("WEBGL_lose_context").loseContext();
      return { userAgent: navigator.userAgent, renderer, devicePixelRatio };
    });
    const versions = process.env.BASELINE_ONLY === "1" ? ["baseline"] : ["baseline", "cached"];
    // Keep and label warm-up results; do not mix them into warm medians
    for (const version of versions) {
      responses = [];
      const result = await page.evaluate(
        ({ version, fixture }) => window.measureViewport(version, fixture),
        { version, fixture },
      );
      samples.push({ httpCache, version, temperature: "warmup", run: 0, ...result, responses });
    }
    for (let run = 1; run <= runs; run++) {
      // Alternate order to limit JIT, shader and background-load bias
      for (const version of run % 2 === 0 ? [...versions].reverse() : versions) {
        responses = [];
        const result = await page.evaluate(
          ({ version, fixture }) => window.measureViewport(version, fixture),
          { version, fixture },
        );
        samples.push({ httpCache, version, temperature: "warm", run, ...result, responses });
      }
    }
    for (let run = 1; run <= missRuns; run++) {
      for (const version of run % 2 === 0 ? [...versions].reverse() : versions) {
        responses = [];
        const result = await page.evaluate(
          ({ version, fixture }) => window.measureViewport(version, fixture, true),
          { version, fixture },
        );
        samples.push({ httpCache, version, temperature: "cache-miss", run, ...result, responses });
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `Measured ${runs} runs per version, HTTP cache ${httpCache ? "enabled" : "disabled"}`,
    );
  }
  const summary = [false, true].flatMap((httpCache) =>
    ["warm", "cache-miss"].flatMap((temperature) =>
      ["baseline", "cached"].flatMap((version) => {
        const selected = samples.filter(
          (sample) =>
            sample.httpCache === httpCache &&
            sample.version === version &&
            sample.temperature === temperature,
        );
        if (!selected.length) return [];
        const sorted = selected.map((sample) => sample.readyMs).sort((a, b) => a - b);
        return [
          {
            httpCache,
            temperature,
            version,
            runs: selected.length,
            medianMs:
              (sorted[Math.floor((sorted.length - 1) / 2)] +
                sorted[Math.floor(sorted.length / 2)]) /
              2,
            minMs: sorted[0],
            maxMs: sorted.at(-1),
            p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
            meanStagesMs: Object.fromEntries(
              ["setupMs", "fetchMs", "parseMs", "thumbnailEncodeMs", "renderMs"].map((key) => [
                key,
                selected.reduce((sum, sample) => sum + sample[key], 0) / selected.length,
              ]),
            ),
            fetches: selected.reduce((n, sample) => n + sample.fetches, 0),
            parses: selected.reduce((n, sample) => n + sample.parses, 0),
            thumbnails: selected.reduce((n, sample) => n + sample.thumbnails, 0),
            transferBytes: selected.reduce(
              (n, sample) =>
                n + sample.resources.reduce((n, resource) => n + resource.transferBytes, 0),
              0,
            ),
          },
        ];
      }),
    ),
  );
  const result = {
    measuredAt: new Date().toISOString(),
    baselineRevision,
    baselineSourceSha256: createHash("sha256").update(baselineSource).digest("hex"),
    candidateSourceSha256: createHash("sha256")
      .update(await readFile(new URL("../editor/graphics/scene.ts", import.meta.url)))
      .digest("hex"),
    cacheSourceSha256: createHash("sha256")
      .update(await readFile(new URL("../shared/assets/ModelCache.ts", import.meta.url)))
      .digest("hex"),
    conditions: {
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0].model.trim(),
      logicalProcessors: os.cpus().length,
      ramGiB: os.totalmem() / 2 ** 30,
      browser: browser.version(),
      ...browserDetails,
      host: "800x600",
      viewport: "1366x768",
      network: "localhost; unthrottled",
      cpuThrottling: 1,
      node: process.version,
      fixture: "web/shared/project/fixtures/m1-project.json; full 3-asset development catalogue",
      assets: manifest.assets.map(({ assetId, byteSize, sha256 }) => ({
        assetId,
        byteSize,
        sha256,
      })),
    },
    summary,
    ratios: [false, true].flatMap((httpCache) =>
      ["warm", "cache-miss"].flatMap((temperature) => {
        const baseline = summary.find(
          (row) =>
            row.httpCache === httpCache &&
            row.temperature === temperature &&
            row.version === "baseline",
        );
        const cached = summary.find(
          (row) =>
            row.httpCache === httpCache &&
            row.temperature === temperature &&
            row.version === "cached",
        );
        return cached
          ? [{ httpCache, temperature, baselineOverCached: baseline.medianMs / cached.medianMs }]
          : [];
      }),
    ),
    samples,
  };
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ summary, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
