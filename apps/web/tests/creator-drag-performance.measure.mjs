// Repeat on each checkout with: node tests/creator-drag-performance.measure.mjs LABEL
// Append -general for the general library, -select for immediate versus 500ms selection;
// otherwise Furniture drag and touch simulation run.
// Optional --baseline-head-cache reproduces the recorded baseline where only ModelCache was
// served from HEAD; normally all source is the current checkout. Compare captured source hashes.
// Measurements are local and synthetic; screenshots and raw traces go into ignored test-results.
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
const output = process.argv[2] ?? "baseline";
const dir = `test-results/SCRUM-12/drag-start-${output}`;
await mkdir(dir, { recursive: true });
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "profile-parse",
      enforce: "pre",
      transform(code, id) {
        if (!id.replaceAll("\\", "/").endsWith("/shared/asset-runtime/ModelCache.ts")) return;
        if (process.argv.includes("--baseline-head-cache"))
          code = execFileSync("git", ["show", "HEAD:apps/web/shared/asset-runtime/ModelCache.ts"], {
            encoding: "utf8",
          });
        let a = 'await new GLTFLoader().parseAsync(bytes, "")';
        if (!code.includes(a)) throw Error("parse instrumentation mismatch");
        return {
          code: code.replace(
            a,
            `await (async()=>{const __p=performance.now(); try {return await new GLTFLoader().parseAsync(bytes, "")} finally {globalThis.__profile?.ops.push({name:'parseAsync',start:__p,end:performance.now(),url:asset.url})}})()`,
          ),
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
  let all = [];
  for (const mode of output.includes("profile")
    ? ["mobile-sim"]
    : output.includes("select")
      ? ["select-immediate", "select-wait"]
      : output.includes("general")
        ? ["desktop"]
        : ["desktop", "mobile-sim"]) {
    const context = await browser.newContext(
      mode !== "mobile-sim"
        ? { viewport: { width: 1440, height: 1024 } }
        : {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
          },
    );
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    if (mode === "mobile-sim") await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.addInitScript(() => {
      let p = (window.__profile = {
        events: [],
        frames: [],
        ops: [],
        long: [],
        ghost: [],
        resources: [],
      });
      const mark = (name, extra = {}) => p.events.push({ name, t: performance.now(), ...extra });
      window.__mark = mark;
      let previousRows = 0;
      new MutationObserver(() => {
        const rows = document.querySelectorAll(".object-row").length;
        if (rows !== previousRows) {
          previousRows = rows;
          mark("object-rows", { rows });
        }
      }).observe(document, { childList: true, subtree: true });
      for (const name of [
        "pointerdown",
        "dragstart",
        "dragenter",
        "dragover",
        "drop",
        "dragend",
        "pointerup",
      ])
        document.addEventListener(
          name,
          (e) => {
            if (name === "dragover" && p.events.at(-1)?.name === "dragover") return;
            mark(name, { target: e.target?.className, dropEffect: e.dataTransfer?.dropEffect });
          },
          true,
        );
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          p.long.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
      const step = (t) => {
        p.frames.push(t);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__THREE_DEVTOOLS__.addEventListener("observe", (e) => {
        const r = e.detail;
        if (!r.isWebGLRenderer) return;
        for (const name of ["render", "initTexture", "compileAsync"]) {
          const original = r[name];
          r[name] = function (...args) {
            const start = performance.now();
            if (name === "render") {
              const g = args[0]?.getObjectByName?.("placement-preview");
              if (g?.visible && !p.ghost.length)
                p.ghost.push({ t: start, position: g.position.toArray() });
            }
            try {
              const out = original.apply(this, args);
              if (out?.then)
                return out.finally(() =>
                  p.ops.push({ name, start, end: performance.now(), async: true }),
                );
              return out;
            } finally {
              if (name !== "compileAsync") p.ops.push({ name, start, end: performance.now() });
            }
          };
        }
      });
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (e) => {
      if (e.type() === "error") errors.push(e.text());
    });
    page.on("requestfailed", (request) =>
      errors.push(`requestfailed ${request.url()} ${request.failure()?.errorText}`),
    );
    const project = await serveProject(page, origin);
    await page.goto(project.url);
    await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Third person", exact: true }).click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page.getByRole("button", { name: "Starter room", exact: true }).click();
    await placeAtRoomCenter(page);
    await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 30000 });
    const general = output.includes("general"),
      pickerName = general ? "Asset library" : "Furniture",
      assetName = general ? "Sample crate" : "Modern bench 1";
    await page.evaluate(() => __mark("picker-open-start"));
    await page.getByRole("button", { name: pickerName, exact: true }).click();
    const lib = page.locator(".asset-picker");
    const option = lib.getByRole("button", { name: assetName, exact: true });
    await option.waitFor();
    if (general) {
      const snow = lib.getByRole("button", { name: "Snow globe", exact: true }).locator("img");
      await snow.waitFor();
      await page.waitForFunction(
        () => {
          const b = [...document.querySelectorAll("button")].find(
            (x) => x.getAttribute("aria-label") === "Snow globe",
          );
          const src = b?.querySelector("img")?.getAttribute("src") ?? "";
          return src.startsWith("data:image/png") || src.startsWith("blob:");
        },
        null,
        { timeout: 30000 },
      );
      await page.evaluate(() => __mark("thumbnail-ready"));
    }
    await page.waitForTimeout(1000);
    await page.evaluate(() => __mark("before-first"));
    if (mode.startsWith("select")) {
      await page.evaluate(() => __mark("selection-begin"));
      await option.click();
      await page.evaluate(() => __mark("selection-complete"));
      if (mode === "select-wait") await page.waitForTimeout(500);
      await page.evaluate(() => __mark("add-begin"));
      await lib.getByRole("button", { name: "Add", exact: true }).click();
      await page.evaluate(() => __mark("add-complete"));
      const stage = await page.locator(".viewport-stage").boundingBox();
      await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await page.evaluate(() => __mark("place-click"));
      await page.waitForTimeout(3000);
      await page.evaluate(() =>
        __mark("place-end", { rows: document.querySelectorAll(".object-row").length }),
      );
      await page.screenshot({ path: `${dir}/${mode}-placed.png` });
    } else if (mode === "desktop") {
      for (let n = 1; n <= 2; n++) {
        if (n === 2) {
          if (!(await option.isVisible()))
            await page.getByRole("button", { name: pickerName, exact: true }).click();
          await option.waitFor();
          await page.waitForTimeout(500);
        }
        const card = await option.boundingBox(),
          stage = await page.locator(".viewport-stage").boundingBox();
        await page.evaluate((n) => __mark(`drag-${n}-begin`), n);
        await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
        await page.mouse.down();
        await page.mouse.move(card.x + card.width / 2 + 12, card.y + card.height / 2, { steps: 3 });
        await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 4 });
        if (n === 2) {
          await page.waitForTimeout(1500);
          await page.screenshot({ path: `${dir}/${mode}-ghost.png` });
        }
        await page.mouse.up();
        await page.evaluate((n) => __mark(`drag-${n}-released`), n);
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${dir}/${mode}-placed-${n}.png` });
        await page.evaluate(
          (n) => __mark(`drag-${n}-end`, { rows: document.querySelectorAll(".object-row").length }),
          n,
        );
      }
    } else {
      if (output.includes("profile")) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
        await cdp.send("Profiler.start");
      }
      await option.click();
      await lib.getByRole("button", { name: "Add", exact: true }).click();
      await page.evaluate(() => __mark("tap-place-begin"));
      const stage = await page.locator(".viewport-stage").boundingBox();
      await page.touchscreen.tap(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await page.evaluate(() =>
        __mark("tap-place-end", { rows: document.querySelectorAll(".object-row").length }),
      );
      await page.waitForTimeout(output.includes("profile") ? 1000 : 3000);
      if (output.includes("profile")) {
        const result = await cdp.send("Profiler.stop");
        await writeFile(`${dir}/mobile.cpuprofile`, JSON.stringify(result.profile));
      }
      await page.screenshot({ path: `${dir}/${mode}-placed.png` });
    }
    const state = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const d = gl?.getExtension("WEBGL_debug_renderer_info");
      const device = {
        userAgent: navigator.userAgent,
        dpr: devicePixelRatio,
        gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
        canvas: [...document.querySelectorAll("canvas")].map((c) => ({
          width: c.width,
          height: c.height,
          css: c.getBoundingClientRect().toJSON(),
        })),
      };
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return {
        device,
        profile: window.__profile,
        rows: document.querySelectorAll(".object-row").length,
        resources: performance
          .getEntriesByType("resource")
          .filter((e) => e.name.endsWith(".glb"))
          .map((e) => ({
            name: e.name,
            start: e.startTime,
            duration: e.duration,
            transfer: e.transferSize,
            decoded: e.decodedBodySize,
          })),
      };
    });
    all.push({ mode, errors, ...state });
    await writeFile(
      `${dir}/${mode}.json`,
      JSON.stringify({ browser: browser.version(), mode, errors, ...state }, null, 2),
    );
    await context.close();
    console.log(
      mode,
      JSON.stringify({
        rows: state.rows,
        events: state.profile.events.filter(
          (e) => e.name.includes("drag-") || e.name.includes("tap-place"),
        ),
        long: state.profile.long.filter((e) => e.duration > 50).slice(-10),
      }),
    );
  }
  const hashes = {};
  for (const file of [
    "editor/viewport/Viewport.tsx",
    "editor/graphics/scene.ts",
    "editor/graphics/model-preparation.ts",
    "editor/graphics/placement-preview.ts",
    "editor/App.tsx",
    "editor/graphics/library-previews.ts",
    "editor/graphics/library-preview.worker.ts",
    "editor/graphics/library-preview-frame.ts",
    "shared/asset-runtime/ModelCache.ts",
  ]) {
    try {
      hashes[file] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hashes[file] = null;
    }
  }
  await writeFile(
    `${dir}/result.json`,
    JSON.stringify(
      { timestamp: new Date().toISOString(), browser: browser.version(), origin, hashes, all },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
