import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const isDevelopment = process.env.BUILD_MODE === "development";

// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name) {
  await openLibrary(page);
  await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

try {
  const legacyModel = await fetch(new URL("models/snowglobe.glb", url));
  assert.notEqual(
    Buffer.from(await legacyModel.arrayBuffer())
      .subarray(0, 4)
      .toString("utf8"),
    "glTF",
    "The build must not ship a duplicate public model alongside the catalogue asset",
  );
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
  const snowglobeResponse = page.waitForResponse((response) =>
    /\/assets\/snowglobe-[^/]+\.glb$/.test(new URL(response.url()).pathname),
  );
  await page.goto(url);
  await page.getByRole("heading", { name: "Spatia", exact: true }).waitFor();
  await coreRequest;
  await modelRequest;
  assert.equal(await page.locator("canvas").count(), 0, "Shell renders before Three.js arrives");
  const asset = page
    .locator(".asset-picker")
    .getByRole("button", { name: "test-crate", exact: true });
  await openLibrary(page);
  assert.equal(await asset.isDisabled(), true);
  releaseCore();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.ok((await snowglobeResponse).ok(), "The manifest snowglobe still loads");
  assert.equal(await page.locator("canvas").count(), 1);
  // Packaged builds follow the same room-first authoring flow as the local editor
  await addAsset(page, "test-room");
  await addAsset(page, "test-crate");
  assert.equal(await page.locator(".object-row").count(), 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 0);
  await addAsset(page, "Snow globe");
  assert.equal(await page.locator(".object-row").count(), 1);
  // A collapsed tree must restore the same selected object when reopened
  const placedObjectId = await page.locator(".object-row").getAttribute("data-object-id");
  const disclosure = page.locator(".scene-disclosure");
  await disclosure.press("ArrowLeft");
  assert.equal(await page.locator(".object-row").isVisible(), false);
  await disclosure.press("ArrowRight");
  assert.equal(await page.locator(".object-row").isVisible(), true);
  assert.equal(await page.locator(".object-row").getAttribute("data-object-id"), placedObjectId);
  assert.equal(await page.locator(".object-row").getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 0);

  const sample = page.getByRole("button", { name: "Open sample project", exact: true });
  assert.equal(
    await sample.count(),
    isDevelopment ? 1 : 0,
    "Sample control matches the build mode",
  );
  if (isDevelopment) {
    // Undo above restores the pristine room; leave an authored edit to exercise the save decision.
    await addAsset(page, "test-crate");
    assert.equal(await page.locator(".object-row").count(), 1);
    await sample.click();
    // Opening a sample uses the same save decision as replacing any room-based project
    await page.getByRole("dialog").getByRole("button", { name: "Don’t Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.locator(".object-row").filter({ hasText: "First crate" }).waitFor();
    assert.equal(await page.locator(".object-row").count(), 2);
  }

  const chunks = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.endsWith(".js"))
      .map((entry) => ({ file: new URL(entry.name).pathname, bytes: entry.decodedBodySize })),
  );
  assert.ok(chunks.length >= 3, "Renderer and core stay separate from the shell");
  // Print every chunk's size on failure so the oversized file is obvious from the CI log
  const sizes = JSON.stringify(chunks);
  assert.ok(
    chunks.every((chunk) => chunk.bytes > 0),
    `there exist some empty chunk: ${sizes}`,
  );
  assert.ok(
    chunks.every((chunk) => chunk.bytes < 500_000),
    `there exist a chunk larger than maximum allowed size: ${sizes}`,
  );
  await page.close();

  // Packaged builds must reject incomplete multi-scene playback while keeping the imported editor open
  const contentPage = await browser.newPage();
  contentPage.on("pageerror", (error) => errors.push(error.message));
  await contentPage.goto(url);
  await contentPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const content = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
  );
  // Strip media references so this fixture needs only the model assets shipped with the build
  for (const scene of content.scenes) {
    scene.rules = [];
    for (const object of scene.objects) object.components = [];
  }
  await contentPage.locator("#project-import").setInputFiles({
    name: "two-scene.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(content)),
  });
  await contentPage.locator(".object-row").filter({ hasText: "First crate" }).waitFor();
  await contentPage.getByRole("button", { name: "Preview", exact: true }).click();
  await contentPage
    .getByRole("status")
    .filter({ hasText: "This preview does not support all the scenes and interactions" })
    .waitFor();
  assert.equal(await contentPage.locator(".editor-shell.is-previewing").count(), 0);
  await contentPage.close();

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
  console.log(
    `PASS: ${isDevelopment ? "development" : "production"} build controls, shell before renderer, chunk budget, placement and chunk recovery`,
  );
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
