import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(target);
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
  const style = (locator, properties) =>
    locator.evaluate((element, properties) => {
      const css = getComputedStyle(element);
      return Object.fromEntries(
        properties.map((property) => [property, css.getPropertyValue(property)]),
      );
    }, properties);
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const tree = page.getByRole("heading", { name: /^Scene Tree/ });
  assert.equal(await tree.count(), 1, "Scene Tree heading uses title case");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const views = page.getByRole("heading", { name: "Saved Views", exact: true });
  await views.waitFor();
  assert.equal(await views.count(), 1, "Saved Views heading uses title case");
  const capture = page.getByRole("button", { name: "Capture current view", exact: true });
  assert.deepEqual(
    await style(capture, ["font-size", "font-weight", "border-radius"]),
    { "font-size": "13px", "font-weight": "400", "border-radius": "10px" },
    "Capture button retains its original styling",
  );
  await page.getByRole("textbox", { name: "View name" }).fill("Browser view");
  await capture.click();
  await page.getByRole("button", { name: "Choose a saved view" }).click();
  assert.equal(
    await page.getByRole("button", { name: "1. Browser view", exact: true }).count(),
    1,
    "Captured view appears in picker",
  );
  await views.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/panel-views-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await views.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/panel-views-narrow.png" });
  console.log("Panel style and saved view controls passed");
} finally {
  await browser.close();
}
