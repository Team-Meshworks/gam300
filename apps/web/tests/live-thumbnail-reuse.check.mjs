import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  await page.addInitScript(() => {
    window.liveThumbnailDraws = [];
    window.liveThumbnailReadbacks = [];
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (this.closest(".viewport-stage") && this.width === 320 && this.height === 320)
        window.liveThumbnailReadbacks.push(performance.now());
      return toDataURL.apply(this, args);
    };
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
      const renderer = event.detail;
      if (!renderer.isWebGLRenderer) return;
      const render = renderer.render;
      renderer.render = function (...args) {
        const start = performance.now();
        const liveThumbnail =
          renderer.domElement.closest(".viewport-stage") &&
          renderer.domElement.width === 320 &&
          renderer.domElement.height === 320;
        try {
          return render.apply(this, args);
        } finally {
          if (liveThumbnail) window.liveThumbnailDraws.push(performance.now() - start);
        }
      };
    });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = await serveProject(page, origin);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await placeAtRoomCenter(page);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const library = page.locator(".asset-picker");
  const card = library.getByRole("button", { name: "Snow globe", exact: true });
  await card.waitFor();
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll("button")].find(
        (node) => node.getAttribute("aria-label") === "Snow globe",
      );
      const source = button?.querySelector("img")?.getAttribute("src") ?? "";
      return source.startsWith("data:image/png") || source.startsWith("blob:");
    },
    null,
    { timeout: 30000 },
  );
  const cardThumbnail = await card.locator("img").getAttribute("src");
  await page.evaluate(() => {
    window.liveThumbnailDraws.length = 0;
    window.liveThumbnailReadbacks.length = 0;
  });
  await card.click();
  await library.getByRole("button", { name: "Add", exact: true }).click();
  const stage = await page.locator(".viewport-stage").boundingBox();
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 1, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  assert.equal(
    await card.locator("img").getAttribute("src"),
    cardThumbnail,
    "The generated card thumbnail remains available after placement",
  );
  const result = await page.evaluate(() => ({
    draws: window.liveThumbnailDraws,
    readbacks: window.liveThumbnailReadbacks,
  }));
  console.log(JSON.stringify({ ...result, errors }));
  assert.deepEqual(errors, []);
  assert.deepEqual(
    result.draws,
    [],
    "A completed card thumbnail should not be redrawn on the live canvas",
  );
  assert.deepEqual(
    result.readbacks,
    [],
    "A completed card thumbnail should not be read back on the live canvas",
  );
  const deadline = Date.now() + 12000;
  while (
    Date.now() < deadline &&
    !project
      .document()
      ?.scenes[0]?.objects.some((object) => object.assetId === "sample-snowglobe-v1")
  )
    await page.waitForTimeout(100);
  assert.ok(
    project
      .document()
      ?.scenes[0]?.objects.some((object) => object.assetId === "sample-snowglobe-v1"),
    "The placed snow globe was saved before restoring the project",
  );
  await page.reload();
  await openSavedProject(page);
  await page.waitForFunction(
    () => {
      const src = document.querySelector(".object-row img")?.getAttribute("src") ?? "";
      return src.startsWith("data:image/png") || src.startsWith("blob:");
    },
    null,
    { timeout: 30000 },
  );
  const restored = await page.evaluate(() => ({
    draws: window.liveThumbnailDraws,
    readbacks: window.liveThumbnailReadbacks,
  }));
  console.log(JSON.stringify({ restored, errors }));
  assert.deepEqual(errors, []);
  assert.deepEqual(restored.draws, [], "Restoring an object generates artwork off the live canvas");
  assert.deepEqual(
    restored.readbacks,
    [],
    "Restoring an object does not read back the live canvas",
  );
} finally {
  await browser?.close();
  await server.close();
}
