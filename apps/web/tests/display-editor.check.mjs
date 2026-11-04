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
const screenshots = fileURLToPath(new URL("../test-results/display-editor/", import.meta.url));
await mkdir(screenshots, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://localhost:5173/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "test-room", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Display panels", exact: true }).click();
  await page.getByRole("button", { name: "Square media panel", exact: true }).click();
  const launch = page.getByRole("button", { name: "Edit display content", exact: true });
  await launch.waitFor();
  for (const edge of ["Top", "Left", "Right", "Bottom"]) {
    await page.getByRole("button", { name: "Move toolbar", exact: true }).click();
    await page
      .getByRole("group", { name: "Dock toolbar", exact: true })
      .getByRole("button", { name: edge, exact: true })
      .click();
    assert.equal(
      await launch.evaluate((button) => {
        const b = button.getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === button;
      }),
      true,
      `launcher uncovered with ${edge} dock`,
    );
  }
  for (const [width, height] of [
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(
      await launch.evaluate((button) => {
        const b = button.getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === button;
      }),
      true,
      `launcher uncovered at ${width}px`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  assert.equal(
    await launch.evaluate((button) => {
      const b = button.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === button;
    }),
    true,
    "selected-display action is uncovered",
  );
  await launch.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit display content", exact: true });
  await dialog.waitFor();
  await dialog
    .getByRole("textbox", { name: "Display text", exact: true })
    .fill("Square panel exhibition\nA new perspective");
  await dialog.getByRole("button", { name: "bold", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Caption (optional)", exact: true })
    .fill("Gallery collection, 2026");
  await dialog.getByRole("tab", { name: "Text", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await dialog.getByRole("tab", { name: "Video", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await dialog.getByText("No videos in the library yet", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Add", exact: true }).isEnabled(), false);
  await dialog.getByRole("tab", { name: "Image", exact: true }).click();
  await dialog.getByText("No images in the library yet", { exact: true }).waitFor();
  assert.equal(await dialog.locator('input[type="file"]').count(), 0);
  await dialog.getByRole("tab", { name: "Text", exact: true }).click();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Display text", exact: true }).inputValue(),
    "Square panel exhibition\nA new perspective",
  );
  for (const [width, height] of [
    [1440, 1024],
    [768, 1024],
    [390, 844],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(
      await dialog.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return (
          b.left >= 0 &&
          b.right <= innerWidth &&
          b.top >= 0 &&
          b.bottom <= innerHeight + 1 &&
          el.scrollWidth <= el.clientWidth + 1
        );
      }),
      true,
      `dialog fits ${width}x${height}`,
    );
    await dialog.getByRole("button", { name: "Add", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/text-${width}x${height}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await launch.evaluate((el) => el === document.activeElement),
    true,
    "focus restored to launcher",
  );
  await launch.click();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Display text", exact: true }).inputValue(),
    "Square panel exhibition\nA new perspective",
  );
  assert.equal(
    await dialog.getByRole("button", { name: "bold", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await dialog.getByRole("textbox", { name: "Caption (optional)", exact: true }).inputValue(),
    "Gallery collection, 2026",
  );
  await dialog.getByRole("textbox", { name: "Display text", exact: true }).fill("Discard me");
  await page.keyboard.press("Escape");
  await launch.click();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Display text", exact: true }).inputValue(),
    "Square panel exhibition\nA new perspective",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await launch.click();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Display text", exact: true }).inputValue(),
    "",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await launch.click();
  assert.equal(
    await dialog.getByRole("textbox", { name: "Display text", exact: true }).inputValue(),
    "Square panel exhibition\nA new perspective",
  );
  await page.screenshot({ path: `${screenshots}/text-desktop.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Display cases", exact: true }).click();
  await page.getByRole("button", { name: "Display plinth", exact: true }).click();
  await launch.click();
  const picker = page.getByRole("dialog", { name: "Place an object on this display", exact: true });
  const displayNames = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    return assets.filter((asset) => asset.displayRole).map((asset) => asset.name);
  });
  for (const name of displayNames)
    assert.equal(
      await picker.getByRole("button", { name, exact: true }).count(),
      0,
      `${name} is excluded from physical content choices`,
    );
  await picker.getByRole("button", { name: "test-crate", exact: true }).click();
  await picker.getByRole("button", { name: "Favourite test-crate", exact: true }).click();
  await picker
    .getByRole("searchbox", { name: "Search library", exact: true })
    .fill("nothing matches");
  await picker.getByText("No matching assets", { exact: true }).waitFor();
  assert.equal(
    await picker.getByRole("button", { name: "Add", exact: true }).isEnabled(),
    true,
    "search preserves chosen model",
  );
  await picker.getByRole("button", { name: "Clear search and filters", exact: true }).click();
  await picker.getByRole("combobox", { name: "Filter assets", exact: true }).click();
  await page.getByRole("option", { name: "Favourites", exact: true }).click();
  assert.equal(await picker.locator(".display-card").count(), 1);
  await page.screenshot({ path: `${screenshots}/physical-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await picker.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return b.left >= 0 && b.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
    }),
    true,
    "physical picker fits phone",
  );
  await picker.getByRole("combobox", { name: "Filter assets", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await picker.isVisible(), true, "first Escape dismisses only the filter");
  await page.screenshot({ path: `${screenshots}/physical-phone.png` });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  await launch.click();
  assert.equal(
    await picker
      .getByRole("button", { name: "test-crate", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await picker.getByRole("button", { name: "Remove content", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 2);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: square panel placement; uncovered keyboard launcher; responsive dialog; tabs/empty media; text, marks and caption saved; cancel/focus/undo/redo; physical search, favourites, attachment and removal.",
  );
} finally {
  await browser.close();
}
