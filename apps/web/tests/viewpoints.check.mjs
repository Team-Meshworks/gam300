import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, target);
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: /^Scene Tree/ }).count(),
    1,
    "Scene Tree heading is present before creating a scene",
  );
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  assert.equal(
    await page.getByRole("heading", { name: "Saved Views", exact: true }).count(),
    1,
    "Saved Views heading is present before creating a scene",
  );
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const tree = page.getByRole("heading", { name: /^Scene Tree/ });
  assert.equal(await tree.count(), 1, "Scene tree remains accessible after placement");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const views = page.getByRole("heading", { name: "Saved Views", exact: true });
  await views.waitFor();
  const capture = page.getByRole("button", { name: "Capture current view", exact: true });
  await page.getByRole("textbox", { name: "View name" }).fill("Browser view");
  await capture.click();
  await page.getByRole("button", { name: "Choose a saved view" }).click();
  assert.equal(
    await page.getByRole("button", { name: "1. Browser view", exact: true }).count(),
    1,
    "Captured view appears in picker",
  );
  await page.getByRole("button", { name: "1. Browser view", exact: true }).click();
  await page.getByRole("button", { name: "Browser view", exact: true }).click();
  await page.getByRole("button", { name: "Delete view", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm view deletion" });
  const warning = await confirmation.innerText({ timeout: 5000 });
  assert.match(warning, /Browser view/);
  assert.match(warning, /navigation points/i);
  assert.match(warning, /rules/i);
  assert.match(warning, /undo restores/i);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await confirmation.count(), 0, "Cancel closes the confirmation");
  assert.equal(
    await page.getByRole("button", { name: "Browser view", exact: true }).count(),
    1,
    "Cancel preserves the selected view",
  );
  await page.getByRole("button", { name: "Delete view", exact: true }).click();
  await confirmation.getByRole("button", { name: "Confirm delete view", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Browser view", exact: true }).count(),
    0,
    "Confirm removes the view",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: /^(Choose a saved view|Browser view)$/ }).click();
  assert.equal(
    await page.getByRole("button", { name: "1. Browser view", exact: true }).count(),
    1,
    "Undo restores the view",
  );
  if (process.env.CHECK_SCREENSHOT) await page.screenshot({ path: process.env.CHECK_SCREENSHOT });
  console.log("Saved view capture and picker checks passed");
} finally {
  await browser.close();
}
