import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
import * as THREE from "three";
await mkdir("test-results/text-placement", { recursive: true });
const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5185/",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5185/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  async function add(category, name, x = 600, y = 350) {
    await page.getByRole("button", { name: category, exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await page.locator(".viewport-stage").click({ position: { x, y } });
  }
  async function document() {
    return await page.evaluate(async () => {
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const result = await loadRecoverySession(
        new Map(assets.map((asset) => [asset.id, asset.kind])),
      );
      return result.ok ? result.value?.document : null;
    });
  }
  async function saved(predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const doc = await document();
      if (doc && predicate(doc)) return doc;
      await page.waitForTimeout(100);
    }
    throw new Error("Expected text did not reach recovery storage");
  }
  await add("Rooms", "test-room");
  await add("Display panels", "Square media stand");
  await page.locator(".object-row").first().click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const dialog = page.locator(".pdf-content-dialog");
  const input = dialog.getByRole("textbox", { name: "Text", exact: true });
  await input.fill("Screen description");
  await dialog.getByRole("button", { name: "Text color", exact: true }).hover();
  assert.equal(
    await dialog.getByRole("tooltip", { name: "Text Color", exact: true }).isVisible(),
    true,
  );
  await dialog.getByRole("button", { name: "Text color", exact: true }).click();
  const palette = dialog.getByRole("group", { name: "Text colors", exact: true });
  assert.ok((await palette.boundingBox()).width <= 200);
  const circles = await palette.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return [box.width, box.height];
    }),
  );
  assert.ok(circles.every(([width, height]) => Math.abs(width - height) < 0.5));
  assert.ok(
    await palette
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.every((button) => getComputedStyle(button).borderRadius === "50%"),
      ),
    "Swatches must be circles, not rounded squares",
  );
  const labels = await dialog
    .locator(".content-format > .content-color-control > button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  assert.equal(
    labels.indexOf("Text background"),
    labels.indexOf("Text color") + 1,
    "Background must be next to text color",
  );
  await palette.screenshot({ path: "test-results/text-placement/compact-colors.png" });
  await dialog.getByRole("button", { name: "Text color #cdbc43", exact: true }).click();
  assert.equal(await palette.isVisible(), true, "Text palette stays open after swatching");
  await dialog.getByRole("button", { name: "Text background", exact: true }).click();
  await dialog.getByRole("button", { name: "Background #46577d", exact: true }).click();
  const backgrounds = dialog.getByRole("group", { name: "Text background colors", exact: true });
  assert.equal(
    await backgrounds.isVisible(),
    true,
    "Background palette stays open after swatching",
  );
  assert.ok(
    (await backgrounds.boundingBox()).width > 150,
    "Palette shell must contain the whole swatch grid",
  );
  assert.equal(
    await dialog
      .locator(".content-background-icon")
      .evaluate((el) => getComputedStyle(el).borderRadius),
    "50%",
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Text background", exact: true })
      .evaluate((el) => getComputedStyle(el).borderRadius),
    "12px",
  );
  await dialog.getByRole("combobox", { name: "Font size", exact: true }).click();
  const menu = dialog.getByRole("listbox", { name: "Font size", exact: true });
  assert.equal(
    await menu.evaluate((el) => el.scrollHeight > el.clientHeight),
    false,
    "Font sizes should fit without a scrollbar",
  );
  const separation = await dialog
    .getByRole("combobox", { name: "Font size", exact: true })
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNode(el.firstChild);
      return (
        el.querySelector("svg").getBoundingClientRect().left - range.getBoundingClientRect().right
      );
    });
  assert.ok(separation >= 3.5, `Font arrow overlaps number: ${separation}`);
  await dialog.screenshot({ path: "test-results/text-placement/font-menu.png" });
  await dialog.getByRole("option", { name: "32", exact: true }).click();
  const controls = await dialog
    .locator(
      ".content-format > button,.content-format > .content-color-control > button,.content-font-size .asset-filter-trigger",
    )
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          radius: getComputedStyle(button).borderRadius,
        };
      }),
    );
  assert.ok(
    controls.every((control) => control.radius === "12px"),
    "Formatting controls share rounded-corner targets",
  );
  await input.hover();
  assert.equal(await input.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
  await dialog.screenshot({ path: "test-results/text-placement/background-font.png" });
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const styled = await saved(
    (doc) => doc.scenes[0].objects[0]?.components?.[0]?.background === "#46577d",
  );
  assert.equal(styled.scenes[0].objects[0].components[0].fontSize, 32);
  assert.equal(styled.scenes[0].objects[0].components[0].color, "#cdbc43");
  await add("Display cases", "Display plinth", 650, 420);
  await page.locator(".object-row").last().click();
  const before = await saved((doc) => doc.scenes[0].objects.length === 2);
  const target = before.scenes[0].objects.find((object) => object.assetId === "display-cube-v1");
  async function draft() {
    await page.getByRole("button", { name: "Edit text", exact: true }).click();
    assert.equal(
      await dialog.getByRole("button", { name: "Text background", exact: true }).count(),
      1,
    );
    await input.fill("Case description");
    await dialog.getByRole("combobox", { name: "Font size", exact: true }).click();
    await dialog.getByRole("option", { name: "28", exact: true }).click();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await page.locator(".viewport-stage[data-placing-text]").waitFor();
  }
  await draft();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("[data-placing-text]").count(), 0);
  assert.deepEqual(await document(), before);
  await draft();
  const stage = page.locator(".viewport-stage"),
    box = await stage.boundingBox(),
    pose = before.scenes[0].startCamera;
  const camera = new THREE.PerspectiveCamera(pose.fovDegrees, box.width / box.height, 0.01, 1000);
  camera.position.fromArray(pose.position);
  camera.quaternion.fromArray(pose.rotation);
  camera.updateMatrixWorld();
  const point = new THREE.Vector3(
    target.transform.position[0],
    target.transform.position[1] + 0.65,
    target.transform.position[2] + 0.3,
  ).project(camera);
  const cx = box.x + ((point.x + 1) / 2) * box.width,
    cy = box.y + ((1 - point.y) / 2) * box.height;
  let chosen;
  for (const origin of [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: cx, y: cy },
  ]) {
    for (const dy of [0, -15, 15, -30, 30, -60, 60]) {
      for (const dx of [0, -15, 15, -30, 30, -60, 60]) {
        const x = origin.x + dx,
          y = origin.y + dy;
        if (x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) continue;
        await page.mouse.move(x, y);
        if ((await stage.getAttribute("data-text-placement-valid")) === "true") {
          chosen = { x, y };
          break;
        }
      }
      if (chosen) break;
    }
    if (chosen) break;
  }
  assert.ok(chosen, "The case front must accept a placement preview");
  assert.deepEqual(await document(), before);
  await page.screenshot({ path: "test-results/text-placement/preview.png" });
  await page.mouse.click(chosen.x, chosen.y);
  await page.locator(".viewport-stage[data-placing-text]").waitFor({ state: "detached" });
  const placed = await saved(
    (doc) =>
      doc.scenes[0].objects.find((object) => object.id === target.id)?.components?.[0]?.placement,
  );
  const text = placed.scenes[0].objects.find((object) => object.id === target.id).components[0];
  assert.equal(text.fontSize, 28);
  assert.equal(text.background, undefined);
  assert.ok(text.placement.scale[0] > 0);
  await page.screenshot({ path: "test-results/text-placement/placed.png" });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Exit preview", exact: true }).waitFor();
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await saved(
    (doc) =>
      doc.scenes[0].objects.find((object) => object.id === target.id).components.length === 0,
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  const redone = await saved(
    (doc) =>
      doc.scenes[0].objects.find((object) => object.id === target.id)?.components?.[0]?.placement,
  );
  assert.deepEqual(
    redone.scenes[0].objects.find((object) => object.id === target.id).components[0],
    text,
  );
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const reopened = await document();
  assert.deepEqual(
    reopened.scenes[0].objects.find((object) => object.id === target.id).components[0],
    text,
  );
  await page.locator(".object-row").last().click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  await dialog.getByRole("button", { name: "Text background", exact: true }).click();
  await dialog
    .getByRole("group", { name: "Text background colors", exact: true })
    .getByRole("button")
    .first()
    .click();
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  assert.equal(
    await page.locator("[data-placing-text]").count(),
    0,
    "Editing placed text must not restart placement",
  );
  const edited = await saved(
    (doc) =>
      doc.scenes[0].objects.find((object) => object.id === target.id).components[0]?.background,
  );
  assert.deepEqual(
    edited.scenes[0].objects.find((object) => object.id === target.id).components[0].placement,
    text.placement,
  );
  for (const row of [page.locator(".object-row").last(), page.locator(".object-row").first()]) {
    await row.click();
    const removeText = page.getByRole("button", { name: "Remove text", exact: true });
    await removeText.hover();
    assert.equal(await removeText.locator(".exhibit-remove-badge svg").count(), 1);
    const alignment = await removeText.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector(".icon").getBoundingClientRect();
      return {
        x: Math.abs(bounds.x + bounds.width / 2 - icon.x - icon.width / 2),
        y: Math.abs(bounds.y + bounds.height / 2 - icon.y - icon.height / 2),
      };
    });
    assert.ok(
      alignment.x < 1 && alignment.y < 1,
      "Remove text icon must be centred in its hover target",
    );
    await removeText.click();
    await page
      .getByRole("button", { name: "Remove text", exact: true })
      .waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Remove text", exact: true }).waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: screen background/font, no hover border, case text preview, cancel without saving, placement, Undo/Redo and reload.",
  );
} finally {
  await browser.close();
}
