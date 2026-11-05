import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(target);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
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
  const headingProperties = ["font-family", "font-size", "font-weight", "color", "line-height"];
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  const interactionHeading = page.getByRole("heading", { name: "Interactions", exact: true });
  const headingStyle = await style(interactionHeading, headingProperties);
  const addStyle = await style(
    page.getByRole("button", { name: "+ Add Interaction", exact: true }),
    ["font-family", "font-size", "font-weight", "border-radius"],
  );
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const tree = page.getByRole("heading", { name: /^Scene Tree/ });
  assert.equal(await tree.count(), 1, "Scene Tree heading uses title case");
  assert.deepEqual(
    await style(tree, headingProperties),
    headingStyle,
    "Scene Tree heading matches Interactions",
  );
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const views = page.getByRole("heading", { name: "Saved Views", exact: true });
  await views.waitFor();
  assert.equal(await views.count(), 1, "Saved Views heading uses title case");
  assert.deepEqual(
    await style(views, headingProperties),
    headingStyle,
    "Saved Views heading matches Interactions",
  );
  const capture = page.getByRole("button", { name: "Capture current view", exact: true });
  assert.deepEqual(
    await style(capture, ["font-family", "font-size", "font-weight", "border-radius"]),
    addStyle,
    "Capture button matches Interaction action",
  );
  await page.getByRole("textbox", { name: "View name" }).fill("Browser view");
  await capture.click();
  await page.getByRole("button", { name: "Choose a saved view" }).click();
  assert.equal(
    await page.getByRole("button", { name: "1. Browser view", exact: true }).count(),
    1,
    "Captured view appears in picker",
  );
  await page.screenshot({ path: "test-results/panel-views-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/panel-views-narrow.png" });
  console.log("Panel style and saved view controls passed");
} finally {
  await browser.close();
}
