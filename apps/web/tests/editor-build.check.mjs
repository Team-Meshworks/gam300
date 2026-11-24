import { placeAtRoomCenter } from "./placement-fixture.mjs";
import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveProject } from "./authoring-project-fixture.mjs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:4173/",
  args: ["--enable-unsafe-swiftshader"],
});
const url = new URL("/", process.argv[2] ?? "http://127.0.0.1:4173/").href;
const isDevelopment = process.env.BUILD_MODE === "development";
const manifest = JSON.parse(
  readFileSync(new URL("../../../assets/manifest.json", import.meta.url), "utf8"),
);
const snowglobeHash = manifest.assets.find(
  (asset) => asset.assetId === "sample-snowglobe-v1",
).sha256;

// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name) {
  // Rooms use their own tray and the existing viewport placement gesture
  if (name === "Starter room") {
    if (await page.locator(".asset-picker").count()) await page.keyboard.press("Escape");
    const overview = page.getByRole("button", { name: "Third person", exact: true });
    if ((await overview.getAttribute("aria-pressed")) !== "true") await overview.click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    await placeAtRoomCenter(page);
    return;
  }
  await openLibrary(page);
  await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await placeAtRoomCenter(page);
}

let page;
const errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, url);
  page.on("pageerror", (error) => errors.push(error.message));
  const corePath = "**/assets/three-core-*.js";
  const scenePath = "**/assets/scene-*.js";
  const { promise: coreGate, resolve: releaseCore } = Promise.withResolvers();
  await page.route(corePath, async (route) => {
    await coreGate;
    await route.continue();
  });
  const coreRequest = page.waitForRequest(corePath);
  const sceneRequest = page.waitForRequest(scenePath);
  // The blocked renderer chunk can delay the load event; the shell must render while it is pending.
  await page.goto(project.url, { waitUntil: "commit" });
  await page.getByRole("heading", { name: "Spatia", exact: true }).waitFor();
  const [core, renderer] = await Promise.all([coreRequest, sceneRequest]);
  assert.equal(await page.locator("canvas").count(), 0, "Shell renders before Three.js arrives");
  const asset = page
    .locator(".asset-picker")
    .getByRole("button", { name: "Sample crate", exact: true });
  await openLibrary(page);
  assert.equal(await asset.isDisabled(), true);
  releaseCore();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator("canvas").count(), 1);
  // The project editor loads selected assets on demand.
  await addAsset(page, "Starter room");
  await addAsset(page, "Sample crate");
  assert.equal(await page.locator(".object-row").count(), 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 0);
  const snowglobeResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/restricted-assets/${snowglobeHash}.glb`,
  );
  await addAsset(page, "Snow globe");
  const snowglobe = await snowglobeResponse;
  assert.ok(snowglobe.ok(), "The selected manifest snowglobe loads on demand");
  assert.equal(await page.locator(".object-row").count(), 1);
  const chunks = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.endsWith(".js"))
      .map((entry) => ({ file: new URL(entry.name).pathname, bytes: entry.decodedBodySize })),
  );
  for (const request of [core, renderer]) {
    const path = new URL(request.url()).pathname;
    assert.ok(
      chunks.some((chunk) => chunk.file === path),
      `Missing loaded chunk: ${path}`,
    );
  }
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

  // Packaged builds must execute supported scene navigation and restore the authoring scene
  const contentPage = await browser.newPage();
  contentPage.on("pageerror", (error) => errors.push(error.message));
  const content = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
  );
  // Strip media references so this fixture needs only the model assets shipped with the build
  for (const scene of content.scenes) {
    scene.rules = [];
    for (const object of scene.objects) object.components = [];
  }
  content.scenes.forEach((scene, index) => {
    const hotspotId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    scene.hotspots = [{ id: hotspotId, objectId: scene.objects[0].id, position: [0, 1, 0] }];
    scene.interactions = [
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspotId },
        do: { type: "navigate-scene", sceneId: content.scenes[1 - index].id },
      },
    ];
  });
  const contentProject = await serveProject(contentPage, url, content);
  await contentPage.goto(contentProject.url);
  await contentPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await contentPage.locator(".object-row").filter({ hasText: "First crate" }).waitFor();
  await contentPage.getByRole("button", { name: "Preview", exact: true }).click();
  await contentPage.getByRole("region", { name: "Exhibition", exact: true }).waitFor();
  await contentPage.getByText("Exhibit information", { exact: true }).click();
  const targets = contentPage.getByRole("region", { name: "Exhibit information" });
  await targets.getByRole("button", { name: "Activate First crate", exact: true }).click();
  await targets.getByRole("button", { name: "Activate Second-scene crate", exact: true }).waitFor();
  assert.equal(
    await contentPage.getByRole("region", { name: "Exhibition", exact: true }).count(),
    1,
  );
  await targets.getByRole("button", { name: "Activate Second-scene crate", exact: true }).click();
  await targets.getByRole("button", { name: "Activate First crate", exact: true }).waitFor();
  await contentPage.getByRole("button", { name: "Exit preview", exact: true }).click();
  await contentPage.locator(".object-row").filter({ hasText: "First crate" }).waitFor();
  assert.equal(
    await contentPage.getByRole("region", { name: "Exhibition", exact: true }).count(),
    0,
  );
  await contentPage.close();

  // Rich v2 scene-start rules execute in the packaged shared player.
  const rich = structuredClone(content);
  rich.scenes[0].rules = [
    {
      id: "30000000-0000-4000-8000-000000000003",
      enabled: true,
      trigger: { type: "sceneStart" },
      actions: [{ type: "setVisible", objectId: rich.scenes[0].objects[0].id, visible: false }],
    },
  ];
  const richPage = await browser.newPage();
  richPage.on("pageerror", (error) => errors.push(error.message));
  const richProject = await serveProject(richPage, url, rich);
  await richPage.goto(richProject.url);
  await richPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await richPage.getByRole("button", { name: "Preview", exact: true }).click();
  await richPage.getByRole("region", { name: "Exhibition", exact: true }).waitFor();
  const hiddenExhibit = richPage.locator('[data-owner-id="' + rich.scenes[0].objects[0].id + '"]');
  await hiddenExhibit.waitFor({ state: "attached" });
  await richPage.waitForFunction(
    (id) => document.querySelector(`[data-owner-id="${id}"]`)?.hidden === true,
    rich.scenes[0].objects[0].id,
  );
  await richPage.getByRole("button", { name: "Exit preview", exact: true }).click();
  assert.equal(await richPage.locator(".object-row").count(), 2);
  await richPage.close();

  // Use a fresh document so an already-evaluated module cannot hide a failed download
  const failed = await browser.newPage();
  const failedProject = await serveProject(failed, url);
  failed.on("pageerror", (error) => errors.push(error.message));
  await failed.route(scenePath, (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await failed.goto(failedProject.url);
  await failed.getByRole("status").filter({ hasText: "Couldn't start the 3D view" }).waitFor();
  await failed.unroute(scenePath);
  await failed.getByRole("button", { name: "Reload editor", exact: true }).click();
  await failed.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await failed.locator("canvas").count(), 1);
  assert.deepEqual(errors, []);
  await failed.close();
  console.log(
    `PASS: ${isDevelopment ? "development" : "production"} build controls, shell before renderer, chunk budget, placement, scene navigation, rich rules and chunk recovery`,
  );
  console.log(JSON.stringify({ chunks }));

  if (process.env.MEASURE_LOAD === "1") {
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const measured = await context.newPage();
      const measuredProject = await serveProject(measured, url);
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
      await measured.goto(measuredProject.url);
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
} catch (error) {
  console.error("Packaged editor failure:", {
    url: page?.url(),
    pageErrors: errors,
    messages: await page
      ?.locator('[role="status"], [role="alert"]')
      .allTextContents()
      .catch(() => []),
    placement: await page
      ?.locator(".viewport-stage")
      .getAttribute("data-placing-asset")
      .catch(() => null),
    body: await page
      ?.locator("body")
      .innerText()
      .catch(() => "Page unavailable"),
  });
  throw error;
} finally {
  await browser.close();
}
