import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser-security.mjs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});
const trays = [
  {
    name: "Display panels",
    files: [
      "horizontal-stand.svg",
      "vertical-stand.svg",
      "vertical-panel.svg",
      "horizontal-panel.svg",
    ],
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
  // Duplicate room names must retain their distinct catalogue identities
  const roomPage = await browser.newPage();
  const duplicateKeys = [];
  roomPage.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("same key")) {
      duplicateKeys.push(message.text());
    }
  });
  const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5173/").origin;
  await roomPage.route("**/__room-options-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div id="root"></div><script type="importmap">{"imports":{"react":"/@id/react","react-dom/client":"/@id/react-dom/client"}}</script><script type="module">
        import RefreshRuntime from "/@react-refresh";
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>`,
    }),
  );
  await roomPage.goto(origin + "/__room-options-test");
  await roomPage.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await roomPage.evaluate(async () => {
    const React = (await import("react")).default;
    const { createRoot } = (await import("react-dom/client")).default;
    const { BottomBar } = await import("/ui/BottomBar.tsx");
    const assets = ["room-a", "room-b"].map((id) => ({
      id,
      name: "Shared room",
      kind: "environment",
      url: "/room.glb",
      sha256: "a".repeat(64),
      thumbnail: null,
    }));
    window.selectedRoomIds = [];
    createRoot(document.getElementById("root")).render(
      React.createElement(BottomBar, {
        assets,
        hotspot: { ...assets[0], id: "hotspot", name: "Hotspot" },
        ready: true,
        thumbnailFor: () => undefined,
        onAdd: (id) => window.selectedRoomIds.push(id),
        onAudio: () => {},
        onDragChange: () => {},
        tool: "select",
        onToolChange: () => {},
        showCameraTools: false,
      }),
    );
  });
  const roomButton = roomPage.getByRole("button", { name: "Rooms", exact: true });
  for (const [index, id] of ["room-a", "room-b"].entries()) {
    await roomButton.focus();
    await roomButton.press("Enter");
    const options = roomPage
      .getByRole("group", { name: "Rooms options" })
      .getByRole("button", { name: "Shared room", exact: true });
    await options.first().waitFor();
    assert.equal(await options.count(), 2);
    await options.nth(index).focus();
    await options.nth(index).press("Enter");
    assert.equal((await roomPage.evaluate(() => window.selectedRoomIds)).at(-1), id);
  }
  assert.deepEqual(duplicateKeys, [], "Room options must use unique React keys");
  await roomPage.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  const registeredDisplays = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    return assets.filter((asset) => asset.displayRole).map(({ id, name }) => ({ id, name }));
  });
  assert.equal(
    registeredDisplays.length,
    8,
    "all display registrations remain available internally",
  );
  const library = page.locator(".asset-picker");
  for (const display of registeredDisplays)
    assert.equal(
      await library.getByRole("button", { name: display.name, exact: true }).count(),
      0,
      `${display.name} belongs to the toolbar, not the general library`,
    );
  const regularNames = await page.evaluate(async () => {
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    return assets
      .filter(
        (asset) =>
          asset.displayRole === undefined &&
          asset.kind === "model" &&
          !asset.id.startsWith("furniture-modern-bench-") &&
          asset.id !== "test-room-module-v1",
      )
      .map((asset) => asset.name);
  });
  for (const name of regularNames)
    assert.equal(
      await library.getByRole("button", { name, exact: true }).count(),
      1,
      `${name} remains in the library`,
    );
  await library.getByRole("searchbox", { name: "Search assets", exact: true }).fill("media");
  assert.equal(await library.locator(".asset-card").count(), 0);
  await library.getByRole("button", { name: "Reset asset filters", exact: true }).click();
  await library.getByRole("button", { name: "Close asset library", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Starter room", exact: true }).click();
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await mkdir(screenshots, { recursive: true });
  let placed = 0;
  const placementPoints = [
    { x: 560, y: 440 },
    { x: 650, y: 405 },
    { x: 750, y: 405 },
    { x: 850, y: 440 },
    { x: 590, y: 500 },
    { x: 680, y: 475 },
    { x: 780, y: 475 },
    { x: 870, y: 500 },
  ];
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
      assert.deepEqual(geometry.rendered, [36, 36]);
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
      assert.equal(
        await trigger.locator("img").evaluate((image) => {
          const bounds = image.getBoundingClientRect();
          const button = image.parentElement.getBoundingClientRect();
          return (
            bounds.left >= button.left &&
            bounds.top >= button.top &&
            bounds.right <= button.right &&
            bounds.bottom <= button.bottom
          );
        }),
        true,
      );
      await page.locator(".viewport-stage").click({ position: placementPoints[placed] });
      placed += 1;
      await page.waitForFunction(
        (count) => document.querySelectorAll(".object-row").length === count,
        placed,
      );
    }
  }
  assert.equal(placed, 8);
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
    if (saved?.scenes[0].objects.length === 8) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(
    saved.scenes[0].objects.map((object) => object.assetId).sort(),
    registeredDisplays.map((asset) => asset.id).sort(),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".object-row").first().waitFor();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator(".object-row").count(), 8);
  assert.deepEqual(errors, []);
  console.log(
    "Display tools: eight registrations retained, hidden from general library/search, regular assets retained; toolbar SVGs, keyboard placement, saved references and reload passed.",
  );
} finally {
  await browser.close();
}
