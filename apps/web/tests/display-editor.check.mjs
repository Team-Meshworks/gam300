import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
await mkdir("test-results/display-editor", { recursive: true });
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5185/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  // Dev now starts in first person; placement checks use the overview camera.
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  async function centeredHearts(root) {
    const offsets = await root.locator(".asset-favourite").evaluateAll((buttons) =>
      buttons.map((button) => {
        const target = button.getBoundingClientRect(),
          icon = button.querySelector("svg").getBoundingClientRect();
        return [
          Math.abs(target.x + target.width / 2 - icon.x - icon.width / 2),
          Math.abs(target.y + target.height / 2 - icon.y - icon.height / 2),
        ];
      }),
    );
    for (const [x, y] of offsets) assert.ok(x < 0.5 && y < 0.5, `Heart center offset: ${x}, ${y}`);
  }
  async function chrome(root) {
    return await root.evaluate((el) => {
      const result = {};
      for (const selector of [
        ".asset-search",
        ".asset-search input",
        ".asset-filter-trigger",
        ".asset-picker-reset",
        ".asset-picker-add",
      ]) {
        const node = el.querySelector(selector);
        if (!node) continue;
        const css = getComputedStyle(node),
          box = node.getBoundingClientRect();
        result[selector] = {
          fontFamily: css.fontFamily,
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
          padding: css.padding,
          borderRadius: css.borderRadius,
          background: css.backgroundColor,
          height: box.height,
          ...([".asset-filter-trigger", ".asset-picker-reset", ".asset-picker-add"].includes(
            selector,
          )
            ? { width: box.width }
            : {}),
        };
      }
      const box = el.getBoundingClientRect();
      return { width: box.width, height: box.height, controls: result };
    });
  }
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const reference = await chrome(page.locator(".asset-picker"));
  await centeredHearts(page.locator(".asset-picker"));
  await page.getByRole("button", { name: "Close asset library", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page
    .getByRole("group", { name: "Rooms options", exact: true })
    .getByRole("button", { name: "test-room", exact: true })
    .click();
  await page.locator(".viewport-stage").click({ position: { x: 600, y: 350 } });
  await page.getByRole("button", { name: "Display panels", exact: true }).click();
  await page.getByRole("button", { name: "Square media stand", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 600, y: 350 } });
  await page.locator(".object-row").first().click();
  assert.equal(
    await page.getByRole("button", { name: "Display asset library", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const content = page.locator(".pdf-content-dialog");
  const input = content.getByRole("textbox", { name: "Text", exact: true });
  await input.fill("");
  await input.pressSequentially("Yes ok and yeah the caret stays beside this text");
  assert.equal(await input.getAttribute("contenteditable"), "plaintext-only");
  assert.equal(await content.locator(".content-text-preview").count(), 0);
  const delta = await input.evaluate((el) => {
    const caret = getSelection().getRangeAt(0).cloneRange();
    caret.collapse(false);
    const all = document.createRange();
    all.selectNodeContents(el);
    const rects = all.getClientRects();
    return Math.abs(caret.getBoundingClientRect().right - rects[rects.length - 1].right);
  });
  assert.ok(delta < 1, `Caret and visible text differ by ${delta}px`);
  await content.screenshot({ path: "test-results/display-editor/text-caret.png" });
  await content.getByRole("button", { name: "Image", exact: true }).click();
  await centeredHearts(content);
  const imageChrome = await chrome(content);
  assert.equal(imageChrome.width, reference.width);
  assert.equal(imageChrome.height, reference.height);
  assert.deepEqual(imageChrome.controls, reference.controls);
  assert.equal(await content.getByRole("textbox", { name: /caption/i }).count(), 0);
  assert.equal(await content.locator(".asset-card").count(), 6);
  await content.getByRole("button", { name: "Video", exact: true }).hover();
  const tabColors = await content.evaluate((el) => ({
    selected: getComputedStyle(
      el.querySelector('button[aria-pressed="true"] .content-tab-background'),
    ).backgroundColor,
    hover: getComputedStyle(el.querySelector('button[aria-label="Video"] .content-tab-background'))
      .backgroundColor,
  }));
  assert.notEqual(tabColors.hover, tabColors.selected, "Hover and selected rail tabs must differ");
  assert.equal(
    await content
      .getByRole("button", { name: "Video", exact: true })
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  await content.getByRole("button", { name: "Video", exact: true }).click();
  assert.equal(await content.locator(".asset-card").count(), 4);
  const card = content.locator(".asset-card").first();
  await card.hover();
  assert.equal(
    await card.locator(".asset-card-pick").evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  const artHeight = await card
    .locator(".asset-art")
    .evaluate((el) => el.getBoundingClientRect().height);
  const screenshot = await card.screenshot();
  const cornerDelta = await page.evaluate(
    async ({ base64, artHeight }) => {
      const image = new Image();
      image.src = "data:image/png;base64," + base64;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const a = ctx.getImageData(4, Math.floor(artHeight) - 4, 1, 1).data,
        b = ctx.getImageData(4, Math.ceil(artHeight) + 4, 1, 1).data;
      return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])));
    },
    { base64: screenshot.toString("base64"), artHeight },
  );
  assert.ok(cornerDelta <= 2, `Thumbnail corner differs from card by ${cornerDelta}`);

  assert.equal(await content.getByRole("textbox", { name: /caption/i }).count(), 0);
  await content.screenshot({ path: "test-results/display-editor/video-library.png" });
  await content
    .getByRole("button", { name: "Sample dunes motion (3 seconds)", exact: true })
    .click();
  await content.getByRole("button", { name: "Add", exact: true }).click();
  const textAction = page.getByRole("button", { name: "Edit text", exact: true });
  assert.equal(await textAction.isDisabled(), true);
  await page.getByRole("button", { name: "Remove video", exact: true }).click();
  assert.equal(await textAction.isEnabled(), true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await textAction.isDisabled(), true);
  await page.getByRole("button", { name: "Remove video", exact: true }).click();
  await page.getByRole("button", { name: "Edit image", exact: true }).click();
  await content.getByRole("button", { name: "Sample landscape", exact: true }).click();
  await content.getByRole("button", { name: "Add", exact: true }).click();
  assert.equal(await textAction.isDisabled(), true);
  await page.getByRole("button", { name: "Remove image", exact: true }).click();
  assert.equal(await textAction.isEnabled(), true);
  await page.getByRole("button", { name: "Display cases", exact: true }).click();
  await page.getByRole("button", { name: "Display plinth", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 620, y: 400 } });
  await page.locator(".object-row").last().click();
  await page.getByRole("button", { name: "Display asset library", exact: true }).click();
  const library = page.getByRole("dialog", {
    name: "Place an object on this display",
    exact: true,
  });
  await centeredHearts(library);
  const physicalChrome = await chrome(library);
  assert.equal(physicalChrome.width, reference.width);
  assert.equal(physicalChrome.height, reference.height);
  assert.deepEqual(physicalChrome.controls, reference.controls);
  assert.equal(await library.locator(".display-editor-object").count(), 0);
  assert.ok((await library.locator(".display-owner").innerText()).includes("Display plinth"));
  assert.equal(
    await library.getByRole("button", { name: "Remove content", exact: true }).count(),
    0,
  );
  assert.equal(await library.locator(".asset-card").count(), 2);
  await library.getByRole("button", { name: "test-crate", exact: true }).click();
  await library.screenshot({ path: "test-results/display-editor/physical-library.png" });
  await library.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  const remove = page.getByRole("button", { name: "Remove displayed object", exact: true });
  await remove.hover();
  assert.equal(
    await page.getByRole("tooltip", { name: "Remove displayed object", exact: true }).isVisible(),
    true,
  );
  await remove.click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 3);
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "test-crate", exact: true })
    .click();
  await page.locator(".asset-picker").getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 700, y: 420 } });
  assert.equal(await page.getByRole("button", { name: "Edit text", exact: true }).count(), 0);
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
