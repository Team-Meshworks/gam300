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
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
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
