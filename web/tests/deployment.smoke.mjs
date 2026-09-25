import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  const response = await page.goto(process.argv[2] ?? "http://127.0.0.1:8081/");
  assert.equal(response.status(), 200);
  assert.ok(response.headers()["content-security-policy"], "The real server applies its policy");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator("canvas").count(), 1);
  const asset = page.getByRole("button", { name: "Add test-crate", exact: true });
  assert.ok(
    await asset.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await asset.click();
  assert.equal(await page.locator(".object-row").count(), 1);
  if (process.env.SMOKE_SCREENSHOT) {
    await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 0);
  assert.deepEqual(errors, [], "Models and embedded textures load under the deployed policy");
  console.log("PASS: packaged editor, server policy, assets, placement and undo");
} finally {
  await browser.close();
}
