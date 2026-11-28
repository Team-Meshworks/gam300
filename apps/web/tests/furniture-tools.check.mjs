import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser-security.mjs";
import { openSavedProject, serveProject } from "./authoring-project-fixture.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = await serveProject(page, process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.goto(project.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const library = page.locator(".asset-picker");
  async function checkFilterPosition() {
    const { right, vertical } = await library.locator(".asset-search").evaluate((search) => {
      const bar = search.getBoundingClientRect();
      // Filters is the last menu; the Tags menu sits to its left once anything is tagged
      const filter = [...search.querySelectorAll('[role="combobox"]')]
        .at(-1)
        .getBoundingClientRect();
      return {
        right: bar.right - filter.right - parseFloat(getComputedStyle(search).paddingRight),
        vertical: bar.y + bar.height / 2 - filter.y - filter.height / 2,
      };
    });
    assert.ok(Math.abs(right) < 1, `Right edge offset: ${right}px`);
    assert.ok(Math.abs(vertical) < 1, `Vertical center offset: ${vertical}px`);
  }
  await checkFilterPosition();
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
    await library.getByRole("heading", { name: "Furniture" }).waitFor();
    const option = library.getByRole("button", { name, exact: true });
    assert.equal(await option.count(), 1, `${name} is available in Furniture`);
    const picture = option.locator(".asset-art img");
    await picture.evaluate((img) => img.decode());
    assert.ok((await picture.getAttribute("src")).includes(`modern-bench-${index + 1}.png`));
    if (index === 0) {
      const filter = library.getByRole("combobox", { name: "Filter furniture", exact: true });
      assert.equal(await filter.textContent(), "Filters");
      await checkFilterPosition();
      await library.getByRole("searchbox", { name: "Search furniture" }).fill("bench 2");
      assert.equal(await option.count(), 0);
      await library.getByRole("button", { name: "Reset furniture filters" }).click();
      await library.getByRole("button", { name: "Favourite Modern bench 1" }).click();
      await filter.click();
      await library.getByRole("option", { name: "Favourites" }).click();
      assert.equal(await library.locator(".asset-card").count(), 1);
      await library.getByRole("button", { name: "Reset furniture filters" }).click();
      await page.screenshot({ path: `${screenshots}/furniture-options.png` });
    }
    await option.click();
    await library.getByRole("button", { name: "Add", exact: true }).click();
    await placeAtRoomCenter(page);
    await page.waitForFunction(
      (count) => document.querySelectorAll(".object-row").length === count,
      index + 1,
    );
    await page.screenshot({ path: `${screenshots}/bench-${index + 1}.png` });
  }
  await page.getByRole("button", { name: "Furniture", exact: true }).click();
  const card = await library
    .getByRole("button", { name: "Modern bench 1", exact: true })
    .boundingBox();
  const stage = await page.locator(".viewport-stage").boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  // Begin dragging on the card before moving to the scene beneath the overlay.
  await page.mouse.move(card.x + card.width / 2 + 12, card.y + card.height / 2, { steps: 4 });
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 2);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  await page.screenshot({ path: `${screenshots}/placed-benches.png` });
  const saved = await project.waitForDocument((doc) => doc.scenes[0]?.objects.length === 3);
  assert.deepEqual(saved.scenes[0].objects.map((object) => object.assetId).sort(), [
    "furniture-modern-bench-1-v1",
    "furniture-modern-bench-1-v1",
    "furniture-modern-bench-2-v1",
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openSavedProject(page);
  assert.equal(await page.locator(".object-row").count(), 3);
  assert.deepEqual(errors, []);
  console.log(
    "Furniture library: GLB snapshots, centered filters, search, favourites, placement, undo/redo and reload passed.",
  );
} finally {
  await browser.close();
}
