import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, origin);
  await page.goto(project.url);
  await openSavedProject(page);
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  const before = structuredClone(project.document());
  assert.equal(await page.getByRole("button", { name: "Test visitor", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("region", { name: "Exhibition", exact: true }).waitFor();
  assert.equal(await page.locator(".editor-shell").count(), 0);
  assert.equal(await page.getByRole("combobox", { name: "Scene", exact: true }).count(), 0);
  assert.equal(await page.locator(".visitor-controls").count(), 0);
  const restart = page.getByRole("button", { name: "Restart preview", exact: true });
  const exit = page.getByRole("button", { name: "Exit preview", exact: true });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 768 });
    const left = await restart.boundingBox();
    const right = await exit.boundingBox();
    assert.ok(left.y < 32 && left.y === right.y && left.x + left.width <= right.x);
    assert.ok(width - right.x - right.width < 32);
  }
  const canvas = await page.locator(".visitor-canvas canvas").elementHandle();
  await restart.click();
  await page.waitForFunction((previous) => !previous.isConnected, canvas);
  await page.getByRole("status").filter({ hasText: "Exhibition ready" }).waitFor();
  await page.setViewportSize({ width: 1366, height: 768 });
  await exit.click();
  await page.getByRole("button", { name: "Preview", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Third person", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(project.document(), before);
  console.log("PASS Preview opens the visitor player and returns to the draft");
} finally {
  await browser?.close();
  await server.close();
}
