import { placeAtRoomCenter } from "./placement-fixture.mjs";
import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { serveProject } from "./authoring-project-fixture.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:8081/";
const browser = await launchBrowser({ target: url, args: ["--enable-unsafe-swiftshader"] });
// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name) {
  // Rooms use their own tray and the existing viewport placement gesture
  if (name === "Starter room") {
    if (await page.locator(".asset-picker").count()) await page.keyboard.press("Escape");
    const overview = page.getByRole("button", { name: "Third person", exact: true });
    if ((await overview.getAttribute("aria-pressed")) !== "true") await overview.click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    await placeAtRoomCenter(page);
    return;
  }
  await openLibrary(page);
  await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await placeAtRoomCenter(page);
}

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const project = await serveProject(page, url);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  const response = await page.goto(project.url);
  assert.equal(response.status(), 200);
  assert.ok(response.headers()["content-security-policy"], "The real server applies its policy");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  assert.equal(await page.locator("canvas").count(), 1);
  await openLibrary(page);
  assert.ok(
    await page
      .locator(".asset-card", {
        has: page.getByRole("button", { name: "Sample crate", exact: true }),
      })
      .locator("img")
      .evaluate(async (image) => {
        await image.decode();
        return image.complete && image.naturalWidth > 0;
      }),
  );
  await addAsset(page, "Starter room");
  await addAsset(page, "Sample crate");
  assert.equal(await page.locator(".object-row").count(), 1);
  if (process.env.CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.CHECK_SCREENSHOT });
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 0);
  // Undo only took the crate away, the room is still there
  await addAsset(page, "Sample crate");
  const originalPosition = await page.getByLabel("Selected position").textContent();
  // No more move buttons, so nudge through the Position panel then go back to the tree
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const field = page.getByRole("textbox", { name: /transform X \(m\)$/ });
  // Compare saved movement with the actual starting pose, independent of placement defaults
  const expectedPosition = await Promise.all(
    ["X", "Y", "Z"].map(async (axis) =>
      Number(
        await page
          .getByRole("textbox", { name: new RegExp(`transform ${axis} \\(m\\)$`) })
          .inputValue(),
      ),
    ),
  );
  expectedPosition[0] += 0.25;
  await field.fill(String(expectedPosition[0]));
  await field.press("Enter");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const movedPosition = await page.getByLabel("Selected position").textContent();
  assert.notEqual(movedPosition, originalPosition);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.getByLabel("Selected position").textContent(), originalPosition);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.locator('.save-state[data-state="saved"]').waitFor();
  assert.equal(project.document().scenes[0].environmentAssetId, "test-room-v1");
  assert.equal(project.document().scenes[0].objects.length, 1);
  assert.deepEqual(
    project
      .document()
      .scenes[0].objects[0].transform.position.map((value) => Number(value.toFixed(2)) || 0),
    expectedPosition,
  );
  await page.reload();
  await page.getByRole("button", { name: "Recover my edits" }).click();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator(".object-row").count(), 1);
  await page.locator(".object-row").first().click();
  assert.equal(await page.getByLabel("Selected position").textContent(), movedPosition);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.getByLabel("Selected position").textContent(), originalPosition);
  assert.deepEqual(errors, [], "Models and embedded textures load under the deployed policy");
  console.log(
    "PASS: packaged editor, server policy, assets, place/move/undo, server save and reload",
  );
} finally {
  await browser.close();
}
