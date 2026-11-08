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
  const legacyModel = await fetch(new URL("models/snowglobe.glb", url));
  assert.notEqual(
    Buffer.from(await legacyModel.arrayBuffer())
      .subarray(0, 4)
      .toString("utf8"),
    "glTF",
    "The build must not ship a duplicate public model alongside the catalogue asset",
  );
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, url);
  page.on("pageerror", (error) => errors.push(error.message));
  const corePath = "**/assets/three-core-*.js";
  const { promise: coreGate, resolve: releaseCore } = Promise.withResolvers();
  await page.route(corePath, async (route) => {
    await coreGate;
    await route.continue();
  });
  const coreRequest = page.waitForRequest(corePath);
  // The blocked renderer chunk can delay the load event; the shell must render while it is pending.
  await page.goto(project.url, { waitUntil: "commit" });
  await page.getByRole("heading", { name: "Spatia", exact: true }).waitFor();
  await coreRequest;
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

  assert.equal(
    await page.getByRole("button", { name: "Open sample project", exact: true }).count(),
    0,
  );

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
  await contentPage.locator(".editor-shell.is-previewing").waitFor();
  const targets = contentPage.getByRole("navigation", { name: "Interactive objects" });
  await targets.getByRole("button", { name: "First crate", exact: true }).click();
  await targets.getByRole("button", { name: "Second-scene crate", exact: true }).waitFor();
  assert.equal(await contentPage.locator(".editor-shell.is-previewing").count(), 1);
  await targets.getByRole("button", { name: "Second-scene crate", exact: true }).click();
  await targets.getByRole("button", { name: "First crate", exact: true }).waitFor();
  await contentPage.getByRole("button", { name: "Exit preview", exact: true }).click();
  await contentPage.locator(".object-row").filter({ hasText: "First crate" }).waitFor();
  assert.equal(await contentPage.locator(".editor-shell.is-previewing").count(), 0);
  await contentPage.close();

  // Rich v2 rules are still unsupported, even when the project's scene navigation is supported.
  const unsupported = structuredClone(content);
  unsupported.scenes[0].rules = [
    {
      id: "30000000-0000-4000-8000-000000000003",
      enabled: true,
      trigger: { type: "sceneStart" },
      actions: [
        {
          type: "moveCamera",
          viewpointId: unsupported.scenes[0].viewpoints[0].id,
          durationSeconds: 1,
        },
      ],
    },
  ];
  const unsupportedPage = await browser.newPage();
  unsupportedPage.on("pageerror", (error) => errors.push(error.message));
  const unsupportedProject = await serveProject(unsupportedPage, url, unsupported);
  await unsupportedPage.goto(unsupportedProject.url);
  await unsupportedPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await unsupportedPage.getByRole("button", { name: "Preview", exact: true }).click();
  await unsupportedPage
    .getByRole("status")
    .filter({ hasText: "This preview does not support all the scenes and interactions" })
    .waitFor();
  assert.match(
    await unsupportedPage
      .getByRole("status")
      .filter({ hasText: "This preview does not support" })
      .innerText(),
    /trigger:sceneStart at project\.scenes\[0\]\.rules\[0\]\.trigger/,
  );
  assert.equal(await unsupportedPage.locator(".editor-shell.is-previewing").count(), 0);
  assert.equal(await unsupportedPage.locator(".object-row").count(), 2);
  await unsupportedPage.close();

  // Use a fresh document so an already-evaluated module cannot hide a failed download
  const failed = await browser.newPage();
  const failedProject = await serveProject(failed, url);
  failed.on("pageerror", (error) => errors.push(error.message));
  const scenePath = "**/assets/scene-*.js";
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
    `PASS: ${isDevelopment ? "development" : "production"} build controls, shell before renderer, chunk budget, placement, scene navigation, unsupported rules and chunk recovery`,
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
