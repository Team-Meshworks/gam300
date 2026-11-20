import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";
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
  const project = await serveProject(page, origin);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await placeAtRoomCenter(page);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  let requests = 0;
  await page.route("**/modern-bench-1.glb*", async (route) => {
    requests++;
    await route.continue();
  });
  await page.getByRole("button", { name: "Furniture", exact: true }).click();
  const library = page.locator(".asset-picker");
  const card = library.getByRole("button", { name: "Modern bench 1", exact: true });
  await card.click();
  // This asset has a supplied image, so the request cannot be picker thumbnail generation.
  await page.waitForTimeout(1000);
  assert.ok(requests > 0, "Selecting the bench should begin preparing it before Add");
  await library.getByRole("button", { name: "Add", exact: true }).click();
  await placeAtRoomCenter(page);
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 1);
  console.log(`Selected bench request count before Add: ${requests}; placement succeeded.`);
} finally {
  await browser?.close();
  await server.close();
}
