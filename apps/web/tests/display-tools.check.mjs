import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const trays = [
  {
    name: "Display panels",
    files: ["horizontal-stand.svg", "vertical-stand.svg", "horizontal-panel.svg"],
  },
  {
    name: "Display cases",
    files: [
      "cube-display-case.svg",
      "clear-cube-display-case.svg",
      "clear-cuboid-display-case.svg",
      "cuboid-display-case.svg",
    ],
  },
];
const screenshots = fileURLToPath(new URL("../test-results/display-tools/", import.meta.url));

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await mkdir(screenshots, { recursive: true });
  let placed = 0;
  for (const tray of trays) {
    const trigger = page.getByRole("button", { name: tray.name, exact: true });
    const options = page.getByRole("group", { name: `${tray.name} options`, exact: true });
    await trigger.click();
    assert.equal(await options.getByRole("button").count(), tray.files.length);
    const images = options.locator("img.figma-tool-icon");
    assert.equal(await images.count(), tray.files.length);
    for (const [index, filename] of tray.files.entries()) {
      const geometry = await images.nth(index).evaluate(async (image) => {
        await image.decode();
        const bounds = image.getBoundingClientRect();
        const button = image.parentElement.getBoundingClientRect();
        return {
          source: new URL(image.src).pathname,
          natural: [image.naturalWidth, image.naturalHeight],
          rendered: [bounds.width, bounds.height],
          contained:
            bounds.left >= button.left &&
            bounds.top >= button.top &&
            bounds.right <= button.right &&
            bounds.bottom <= button.bottom,
          decorative: image.alt === "" && image.getAttribute("aria-hidden") === "true",
          draggable: image.draggable,
        };
      });
      assert.ok(geometry.source.endsWith(filename));
      assert.deepEqual(geometry.natural, [40, 40]);
      assert.deepEqual(geometry.rendered, [40, 40]);
      assert.equal(geometry.contained, true);
      assert.equal(geometry.decorative, true);
      assert.equal(geometry.draggable, false);
    }
    await page.screenshot({
      path: `${screenshots}/${tray.name.toLowerCase().replaceAll(" ", "-")}.png`,
    });
    await page.keyboard.press("Escape");
    assert.equal(await options.count(), 0);
    await trigger.click();
    await trigger.click();
    assert.equal(await options.count(), 0);
    for (const [index, filename] of tray.files.entries()) {
      await trigger.click();
      await options.getByRole("button").nth(index).focus();
      await page.keyboard.press("Enter");
      assert.equal(await options.count(), 0);
      const selectedSource = await trigger.locator("img").getAttribute("src");
      assert.ok(new URL(selectedSource, page.url()).pathname.endsWith(filename));
      placed += 1;
      await page.waitForFunction(
        (count) => document.querySelectorAll(".object-row").length === count,
        placed,
      );
    }
  }
  assert.equal(placed, 7);
  assert.deepEqual(errors, []);
  console.log(
    "Display tool SVGs: seven source assets loaded at 40×40, both trays dismiss/reopen, keyboard placement and selected icons passed.",
  );
} finally {
  await browser.close();
}
