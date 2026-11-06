import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const library = page.locator(".asset-picker");
  for (const name of ["Modern bench 1", "Modern bench 2"])
    assert.equal(await library.getByRole("button", { name, exact: true }).count(), 0);
  await library.getByRole("button", { name: "Close asset library", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await placeAtRoomCenter(page);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const screenshots = fileURLToPath(new URL("../test-results/furniture-tools/", import.meta.url));
  await mkdir(screenshots, { recursive: true });
  for (const [index, name] of ["Modern bench 1", "Modern bench 2"].entries()) {
    await page.getByRole("button", { name: "Furniture", exact: true }).click();
    const option = page
      .getByRole("group", { name: "Furniture options" })
      .getByRole("button", { name, exact: true });
    assert.equal(await option.count(), 1, `${name} is available in Furniture`);
    const icon = option.locator("img.figma-tool-icon");
    assert.equal(await icon.count(), 1);
    assert.ok((await icon.getAttribute("src")).includes("furniture-bench.svg"));
    assert.equal(await icon.getAttribute("alt"), "");
    if (index === 0) await page.screenshot({ path: `${screenshots}/furniture-options.png` });
    await option.click();
    await placeAtRoomCenter(page);
    await page.waitForFunction(
      (count) => document.querySelectorAll(".object-row").length === count,
      index + 1,
    );
    await page.screenshot({ path: `${screenshots}/bench-${index + 1}.png` });
  }
  await page.getByRole("button", { name: "Furniture", exact: true }).click();
  await page
    .getByRole("group", { name: "Furniture options" })
    .getByRole("button", { name: "Modern bench 1", exact: true })
    .dragTo(page.locator(".viewport-stage"));
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 2);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  await page.screenshot({ path: `${screenshots}/placed-benches.png` });
  const deadline = Date.now() + 12000;
  let saved;
  while (Date.now() < deadline) {
    saved = await page.evaluate(async () => {
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const result = await loadRecoverySession(
        new Map(assets.map((asset) => [asset.id, asset.kind])),
      );
      return result.ok ? result.value?.document : null;
    });
    if (saved?.scenes[0].objects.length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(saved.scenes[0].objects.map((object) => object.assetId).sort(), [
    "furniture-modern-bench-1-v1",
    "furniture-modern-bench-1-v1",
    "furniture-modern-bench-2-v1",
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".object-row").first().waitFor();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator(".object-row").count(), 3);
  assert.deepEqual(errors, []);
  console.log(
    "Furniture tools: library exclusion, accessible icons, click and drag placement, undo/redo, saved IDs and reload passed.",
  );
} finally {
  await browser.close();
}
