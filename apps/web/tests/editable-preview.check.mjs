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
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  assert.equal(await page.locator(".editor-shell.is-walking").count(), 1);
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByLabel("Scene name", { exact: true }).fill("Edited in preview");
  await page.getByRole("button", { name: "Rename scene", exact: true }).click();
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await page.getByRole("button", { name: "1. Edited in preview", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Third person", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.getAttribute("data-state") === "saved",
  );
  assert.equal(project.document().scenes[0].name, "Edited in preview");
  console.log("PASS preview edits the saved draft in first person");
} finally {
  await browser?.close();
  await server.close();
}
