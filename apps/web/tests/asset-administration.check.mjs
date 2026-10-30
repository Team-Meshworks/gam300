import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("test-results/scrum168", { recursive: true });
// Compare the rendered hierarchy so later selectors cannot silently enlarge one popup
async function checkDialogTypography() {
  const sizes = await page.getByRole("dialog").evaluate((dialog) => {
    const font = (node) => parseFloat(getComputedStyle(node).fontSize);
    return {
      page: font(document.querySelector(".asset-admin h1")),
      title: font(dialog.querySelector("h2")),
      section: font(dialog.querySelector("h3")),
      controls: [
        ...dialog.querySelectorAll("input:not([type=file]), button:not(.asset-admin-close)"),
      ].map(font),
    };
  });
  assert.ok(sizes.title <= sizes.page, "Popup titles must not overpower the library heading");
  assert.ok(sizes.section < sizes.title, "Section headings stay subordinate to the popup title");
  assert.ok(
    sizes.controls.every((size) => size === 14),
    "Form and action text use one body size",
  );
}

async function choose(label, text) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .getByRole("listbox", { name: label, exact: true })
    .getByRole("option", { name: text, exact: true })
    .click();
}
try {
  // Exercise the real components with the clearly labelled local adapter
  // No fixture response is evidence of authenticated intake or persisted asset approval
  await page.goto(`${process.argv[2] ?? "http://127.0.0.1:5173/"}?asset-admin-test`);
  await page.getByRole("heading", { name: "All 3D Spaces" }).waitFor();
  await page
    .getByRole("button", { name: /View Model/ })
    .first()
    .waitFor();
  await page
    .locator(".asset-admin-thumbnail img")
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await page.screenshot({ path: "test-results/scrum168/list.png", fullPage: true });

  // Balance the frame within the viewport before testing long lists
  const frame = await page.locator(".asset-admin").boundingBox();
  assert.ok(Math.abs(frame.y - (1000 - frame.y - frame.height)) <= 1);
  assert.ok(Math.abs(frame.x - (1400 - frame.x - frame.width)) <= 1);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true,
  );

  // Recessed surfaces and contrasting close controls must survive shared button styles
  for (const selector of [".asset-admin", ".asset-admin-search input"]) {
    assert.match(
      await page.locator(selector).evaluate((el) => getComputedStyle(el).boxShadow),
      /inset/,
    );
  }
  const closeStyle = await page
    .locator(".asset-admin-heading .asset-admin-close")
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      ink: getComputedStyle(el).color,
    }));
  assert.equal(closeStyle.background, "rgb(234, 233, 230)");
  assert.equal(closeStyle.ink, "rgb(8, 8, 8)");

  // Search never removes records; clearing it restores the same visible catalogue
  const initialCount = await page.locator(".asset-admin-card").count();
  await page.getByRole("searchbox", { name: "Search 3D spaces" }).fill("no such sample asset");
  await page.getByRole("heading", { name: "No matching 3D spaces" }).waitFor();
  await page.screenshot({ path: "test-results/scrum168/empty.png" });
  await page.getByRole("button", { name: "Reset search" }).click();
  assert.equal(await page.locator(".asset-admin-card").count(), initialCount);

  // Cancel leaves the list unchanged and native dialog closure restores the opening control
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("textbox", { name: "Asset Type" }).inputValue(), "3D Space");
  assert.equal(
    await dialog.getByRole("textbox", { name: "Asset Type" }).getAttribute("readonly"),
    "",
  );
  await dialog.getByRole("heading", { name: "Upload 3D Space", exact: true }).waitFor();
  await checkDialogTypography();
  await page.screenshot({ path: "test-results/scrum168/upload.png", fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "+ Add 3D Space", exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  assert.equal(await page.locator(".asset-admin-card").count(), initialCount);

  // Cancelling the native picker must not bubble into the enclosing dialog's Escape handler
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  await dialog.getByLabel("Choose asset file").setInputFiles({
    name: "retained-room.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from("local preview only"),
  });
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).isDisabled(), true);
  await dialog
    .getByLabel("Choose asset file")
    .evaluate((input) => input.dispatchEvent(new Event("cancel", { bubbles: true })));
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    await dialog.getByLabel("Choose asset file").evaluate((input) => input.files[0].name),
    "retained-room.glb",
  );
  assert.equal(
    (await dialog.getByRole("combobox", { name: "Filter Category" }).textContent()).trim(),
    "Not configured",
  );
  assert.equal(
    await dialog
      .locator(".asset-admin-upload")
      .evaluate((region) => getComputedStyle(region).backgroundColor),
    "rgb(255, 253, 251)",
  );
  for (const button of await page.locator(".asset-admin-close:visible").all()) {
    const centered = await button.evaluate((element) => {
      const circle = element.getBoundingClientRect();
      const glyph = element.querySelector("svg").getBoundingClientRect();
      return (
        Math.abs(circle.x + circle.width / 2 - glyph.x - glyph.width / 2) <= 1 &&
        Math.abs(circle.y + circle.height / 2 - glyph.y - glyph.height / 2) <= 1
      );
    });
    assert.equal(centered, true);
  }
  assert.equal(
    await dialog
      .locator("h2")
      .evaluate((heading) => parseFloat(getComputedStyle(heading).fontSize) <= 24),
    true,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Reject unsupported selections before submitting while keeping the metadata editable
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  await dialog.getByLabel("Choose asset file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a model"),
  });
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog.getByLabel("Choose asset file").evaluate((input) => input.files[0].name),
    "notes.txt",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Failed submissions keep the chosen bytes and metadata available for retry
  await page.getByText("Local preview controls", { exact: true }).click();
  await choose("Test response", "Save failure");
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  await dialog.getByLabel("Choose asset file").setInputFiles({
    name: "test-room.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from("local preview only"),
  });
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog.getByLabel("Choose asset file").evaluate((input) => input.files[0].name),
    "test-room.glb",
  );
  assert.equal(
    (await dialog.getByRole("combobox", { name: "Filter Category" }).textContent()).trim(),
    "Not configured",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Only the adapter's confirmed pending result enters the list after successful submission
  await choose("Test response", "Normal");
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  await dialog.getByLabel("Choose asset file").setInputFiles({
    name: "new-room.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from("local preview only"),
  });
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "new-room.glb", exact: true }) })
    .getByRole("button")
    .click();
  await dialog.getByText("Pending validation", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();

  // Confirming deletion removes only the record returned as deleted by the adapter
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "new-room.glb", exact: true }) })
    .getByRole("button")
    .click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "new-room.glb", exact: true }).count(), 0);

  // Availability changes follow returned records and still require confirmation for deletion
  await page
    .getByRole("button", { name: /View Model/ })
    .first()
    .click();
  await checkDialogTypography();
  await page.screenshot({ path: "test-results/scrum168/details.png", fullPage: true });
  const viewBounds = await dialog.boundingBox();
  assert.ok(viewBounds.width <= 560, "View dialogs remain compact on desktop");
  assert.ok(viewBounds.height <= 460, "Viewing should not occupy most of the viewport");
  const modelName = await dialog.locator("h2").textContent();
  await dialog.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: /^Private \(/ }).click();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: modelName, exact: true }) })
    .getByRole("button")
    .click();
  await dialog.getByRole("button", { name: "Show", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: modelName, exact: true }).count(), 0);

  // Creators get no intake controls, and server denials are distinct from unavailable service responses
  await choose("Account", "Creator");
  await page.getByRole("heading", { name: "Access denied" }).waitFor();
  await page.screenshot({ path: "test-results/scrum168/denied.png" });
  assert.equal(await page.getByRole("button", { name: /Add 3D Space/ }).count(), 0);
  await choose("Account", "Administrator");
  await choose("Test response", "Denied");
  await page.getByRole("heading", { name: "Access denied" }).waitFor();
  await choose("Test response", "Unavailable");
  await page.getByRole("heading", { name: "Spaces unavailable" }).waitFor();
  await page.screenshot({ path: "test-results/scrum168/unavailable.png" });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: "Spaces unavailable" }).waitFor();

  assert.deepEqual(errors, []);
  console.log("PASS: space intake, cancellation, availability and access states");
} catch (error) {
  await page.screenshot({ path: "test-results/scrum168/failure.png", fullPage: true });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
