import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const url = process.argv[2] ?? "http://127.0.0.1:4173/";

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const corePath = "**/assets/three-core-*.js";
  const { promise: coreGate, resolve: releaseCore } = Promise.withResolvers();
  await page.route(corePath, async (route) => {
    await coreGate;
    await route.continue();
  });
  const coreRequest = page.waitForRequest(corePath);
  const modelRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith(".glb"),
  );
  await page.goto(url);
  await page.getByRole("heading", { name: "VThere Spatial Experience Editor" }).waitFor();
  await coreRequest;
  await modelRequest;
  assert.equal(await page.locator("canvas").count(), 0, "Shell renders before Three.js arrives");
  const asset = page.getByRole("button", { name: "Add test-crate", exact: true });
  assert.equal(await asset.isDisabled(), true);
  releaseCore();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator("canvas").count(), 1);
  await asset.click();
  assert.equal(await page.locator('[data-testid="object-row"]').count(), 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator('[data-testid="object-row"]').count(), 0);

  const chunks = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.endsWith(".js"))
      .map((entry) => ({ file: new URL(entry.name).pathname, bytes: entry.decodedBodySize })),
  );
  assert.ok(chunks.length >= 3, "Renderer and core stay separate from the shell");
  assert.ok(chunks.every((chunk) => chunk.bytes > 0 && chunk.bytes < 500_000));
  await page.close();

  // Use a fresh document so an already-evaluated module cannot hide a failed download
  const failed = await browser.newPage();
  failed.on("pageerror", (error) => errors.push(error.message));
  const scenePath = "**/assets/scene-*.js";
  await failed.route(scenePath, (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await failed.goto(url);
  await failed.getByRole("status").filter({ hasText: "Couldn't start the 3D view" }).waitFor();
  await failed.unroute(scenePath);
  await failed.getByRole("button", { name: "Reload editor", exact: true }).click();
  await failed.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await failed.locator("canvas").count(), 1);
  assert.deepEqual(errors, []);
  await failed.close();
  console.log("PASS: shell before renderer, chunk budget, production placement and chunk recovery");
  console.log(JSON.stringify({ chunks }));

  if (process.env.MEASURE_LOAD === "1") {
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const measured = await context.newPage();
      const session = await context.newCDPSession(measured);
      await session.send("Network.enable");
      await session.send("Network.setCacheDisabled", { cacheDisabled: true });
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 80,
        downloadThroughput: 1_250_000,
        uploadThroughput: 125_000,
      });
      await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await measured.goto(url);
      await measured.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
      samples.push(
        await measured.evaluate(() => ({
          firstContentfulPaintMs:
            performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
          sceneReadyMs: performance.now(),
          javascriptBytes: performance
            .getEntriesByType("resource")
            .filter((entry) => new URL(entry.name).pathname.endsWith(".js"))
            .reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        })),
      );
      await context.close();
    }
    const median = (key) => samples.map((sample) => sample[key]).sort((a, b) => a - b)[1];
    console.log(
      JSON.stringify({
        browser: browser.version(),
        samples,
        median: {
          firstContentfulPaintMs: median("firstContentfulPaintMs"),
          sceneReadyMs: median("sceneReadyMs"),
          javascriptBytes: median("javascriptBytes"),
        },
      }),
    );
  }
} finally {
  await browser.close();
}
