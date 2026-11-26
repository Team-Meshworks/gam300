import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";

// A user can finish placing while a cold model is still loading. Delay only the
// selected model, then require both the first mouse drop and touch placement to
// survive until its geometry is ready. Each case uses a fresh page/cache.
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
const outcomes = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  for (const mode of ["drag", "touch", "cancel", "outside", "unavailable"]) {
    const context = await browser.newContext(
      mode === "drag" || mode === "outside"
        ? { viewport: { width: 1440, height: 1024 } }
        : {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            hasTouch: true,
            isMobile: true,
          },
    );
    try {
      const page = await context.newPage();
      const project = await serveProject(page, origin);
      await page.goto(project.url);
      await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
      await page.getByRole("button", { name: "Third person", exact: true }).click();
      await page.getByRole("button", { name: "Rooms", exact: true }).click();
      await page.getByRole("button", { name: "Starter room", exact: true }).click();
      await placeAtRoomCenter(page);
      await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let requested = false;
      await page.route("**/modern-bench-1.glb*", async (route) => {
        requested = true;
        await gate;
        if (mode === "unavailable") await route.fulfill({ status: 503, body: "Unavailable" });
        else await route.continue();
      });
      await page.getByRole("button", { name: "Furniture", exact: true }).click();
      const library = page.locator(".asset-picker");
      const card = library.getByRole("button", { name: "Modern bench 1", exact: true });
      await card.waitFor();
      const stage = await page.locator(".viewport-stage").boundingBox();
      if (mode === "drag" || mode === "outside") {
        const box = await card.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 4 });
        await page.mouse.move(
          mode === "outside" ? 10 : stage.x + stage.width / 2,
          mode === "outside" ? 10 : stage.y + stage.height / 2,
          { steps: 8 },
        );
        await page.mouse.up();
      } else {
        await card.click();
        await library.getByRole("button", { name: "Add", exact: true }).click();
        await page.touchscreen.tap(stage.x + stage.width / 2, stage.y + stage.height / 2);
      }
      if (mode === "cancel") await page.keyboard.press("Escape");
      // Avoid hanging the server even if the selected model was not requested.
      release();
      await page.waitForTimeout(2500);
      outcomes.push({ mode, requested, rows: await page.locator(".object-row").count() });
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify(outcomes));
  for (const outcome of outcomes) {
    assert.ok(outcome.requested, `${outcome.mode}: selected model should be requested`);
    assert.equal(
      outcome.rows,
      ["cancel", "outside", "unavailable"].includes(outcome.mode) ? 0 : 1,
      `${outcome.mode}: pending placement should complete or be cancelled as requested`,
    );
  }
} finally {
  await browser?.close();
  await server.close();
}
