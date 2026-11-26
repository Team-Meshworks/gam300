import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const cachedPage = await browser.newPage();
  const project = await serveProject(cachedPage, origin);
  // Record exactly what the picker asks the generator to produce, while making
  // the completion deterministic. A generated result must survive reopening.
  await cachedPage.route("**/graphics/library-previews.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function generateLibraryPreviews(assets, done) {
      (window.generationCalls ??= []).push(assets.map(asset => asset.id));
      for (const asset of assets) done(asset.id, 'data:image/png;base64,dGVzdA==');
      return () => {};
    }`,
    }),
  );
  await cachedPage.goto(project.url);
  await cachedPage.getByRole("button", { name: "Asset library", exact: true }).click();
  await cachedPage.waitForFunction(() => window.generationCalls?.length > 0);
  const first = await cachedPage.evaluate(() => window.generationCalls.flat());
  assert.ok(first.length, "The general picker must request at least one missing thumbnail");
  await cachedPage.getByRole("button", { name: "Close asset library", exact: true }).click();
  await cachedPage.getByRole("button", { name: "Asset library", exact: true }).click();
  await cachedPage.waitForTimeout(500);
  const calls = await cachedPage.evaluate(() => window.generationCalls);
  const repeated = calls
    .slice(1)
    .flat()
    .filter((id) => first.includes(id));
  await cachedPage.close();

  async function inspectThumbnail(disableWorker) {
    const page = await browser.newPage();
    await page.addInitScript((disable) => {
      if (disable)
        Object.defineProperty(window, "OffscreenCanvas", { value: undefined, configurable: true });
      window.thumbnailDraws = [];
      window.thumbnailReadbacks = 0;
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        if (this.width === 320 && this.height === 320) window.thumbnailReadbacks++;
        return toDataURL.apply(this, args);
      };
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
        const renderer = event.detail;
        if (!renderer.isWebGLRenderer) return;
        let compiled = false;
        const compileAsync = renderer.compileAsync;
        renderer.compileAsync = async function (...args) {
          const result = await compileAsync.apply(this, args);
          compiled = true;
          return result;
        };
        const render = renderer.render;
        renderer.render = function (scene, camera) {
          if (renderer.domElement.width === 320 && renderer.domElement.height === 320) {
            let transmission = false;
            scene.traverse((node) => {
              const materials = Array.isArray(node.material) ? node.material : [node.material];
              if (materials.some((material) => material?.transmission > 0)) transmission = true;
            });
            window.thumbnailDraws.push({ compiled, transmission });
          }
          return render.call(this, scene, camera);
        };
      });
    }, disableWorker);
    const liveProject = await serveProject(page, origin);
    await page.goto(liveProject.url);
    const supported = await page.evaluate(async () => {
      if (!window.OffscreenCanvas || !window.Worker) return false;
      const source =
        'onmessage=()=>{try{postMessage(!!new OffscreenCanvas(1,1).getContext("webgl2"))}catch(e){postMessage(false)}}';
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try {
        return await new Promise((resolve) => {
          const worker = new Worker(url);
          worker.onmessage = (event) => {
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = () => {
            worker.terminate();
            resolve(false);
          };
          worker.postMessage(null);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
    const image = page.getByRole("button", { name: "Snow globe", exact: true }).locator("img");
    await image.waitFor();
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll("button")].find(
          (el) => el.getAttribute("aria-label") === "Snow globe",
        );
        const src = button?.querySelector("img")?.getAttribute("src") ?? "";
        return src.startsWith("data:image/png") || src.startsWith("blob:");
      },
      null,
      { timeout: 30000 },
    );
    const result = {
      supported,
      image: await image.getAttribute("src"),
      draws: await page.evaluate(() => window.thumbnailDraws),
      readbacks: await page.evaluate(() => window.thumbnailReadbacks),
    };
    result.png = await image.evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    });
    await page.close();
    return result;
  }
  const worker = await inspectThumbnail(false);
  const fallback = await inspectThumbnail(true);
  await mkdir("test-results/SCRUM-12", { recursive: true });
  const label = process.env.THUMBNAIL_PROFILE_LABEL ?? "current";
  for (const [kind, result] of [
    ["worker", worker],
    ["fallback", fallback],
  ]) {
    await writeFile(
      `test-results/SCRUM-12/thumbnail-${label}-${kind}.png`,
      Buffer.from(result.png.split(",")[1], "base64"),
    );
  }
  const comparePage = await browser.newPage();
  const pixels = await comparePage.evaluate(
    async ([a, b]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      const [left, right] = await Promise.all([load(a), load(b)]);
      if (left.width !== right.width || left.height !== right.height) return { sameSize: false };
      const c = document.createElement("canvas");
      c.width = left.width;
      c.height = left.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(left, 0, 0);
      const x = ctx.getImageData(0, 0, c.width, c.height).data;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(right, 0, 0);
      const y = ctx.getImageData(0, 0, c.width, c.height).data;
      let changed = 0,
        max = 0,
        sum = 0;
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - y[i]);
        if (d) changed++;
        max = Math.max(max, d);
        sum += d;
      }
      return {
        sameSize: true,
        width: c.width,
        height: c.height,
        changedChannels: changed,
        totalChannels: x.length,
        maxChannelDifference: max,
        meanChannelDifference: sum / x.length,
      };
    },
    [worker.png, fallback.png],
  );
  await comparePage.close();
  delete worker.png;
  delete fallback.png;
  console.log(
    JSON.stringify({
      first,
      repeated,
      pixels,
      worker: { ...worker, image: !!worker.image },
      fallback: { ...fallback, image: !!fallback.image },
    }),
  );
  assert.deepEqual(repeated, [], "Reopening the library must reuse generated thumbnails");
  assert.ok(worker.image && fallback.image, "The authored snow globe reaches its library card");
  if (worker.supported) {
    assert.deepEqual(
      worker.draws,
      [],
      "Worker WebGL2 must avoid thumbnail draws on the main thread",
    );
    assert.equal(
      worker.readbacks,
      0,
      "Worker WebGL2 must avoid thumbnail readback on the main thread",
    );
  }
  assert.ok(
    fallback.draws.some((draw) => draw.transmission),
    "Fallback draws the actual transmissive model",
  );
  assert.ok(
    fallback.draws.filter((draw) => draw.transmission).every((draw) => draw.compiled),
    "Fallback compiles a transmissive thumbnail before its first draw",
  );
} finally {
  await browser?.close();
  await server.close();
}
