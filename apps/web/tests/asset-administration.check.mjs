import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await launchBrowser({ target: baseUrl });
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
      section: dialog.querySelector("h3") ? font(dialog.querySelector("h3")) : null,
      controls: [
        ...dialog.querySelectorAll("input:not([type=file]), button:not(.asset-admin-close)"),
      ].map(font),
    };
  });
  assert.ok(sizes.title <= sizes.page, "Popup titles must not overpower the library heading");
  assert.ok(
    sizes.section === null || sizes.section < sizes.title,
    "Section headings stay subordinate to the popup title",
  );
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
  await page.goto(`${baseUrl}?asset-admin-test`);
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
  const emptyBounds = await page.locator(".asset-admin-state").boundingBox();
  const listBounds = await page.locator(".asset-admin-scroll").boundingBox();
  assert.ok(
    Math.abs(emptyBounds.y + emptyBounds.height / 2 - listBounds.y - listBounds.height / 2) <= 1,
  );
  assert.ok(
    Math.abs(emptyBounds.x + emptyBounds.width / 2 - listBounds.x - listBounds.width / 2) <= 1,
  );
  await page.screenshot({ path: "test-results/scrum168/empty.png" });
  await page.getByRole("button", { name: "Reset search" }).click();
  assert.equal(await page.locator(".asset-admin-card").count(), initialCount);

  // Cancel leaves the list unchanged and native dialog closure restores the opening control
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // Keep the type in the upload title without repeating it as a field or heading
  assert.equal(await dialog.getByRole("textbox", { name: "Asset Type" }).count(), 0);
  assert.equal(await dialog.locator("h3").count(), 0);
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
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).count(), 0);
  await dialog
    .getByLabel("Choose asset file")
    .evaluate((input) => input.dispatchEvent(new Event("cancel", { bubbles: true })));
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    await dialog.getByLabel("Choose asset file").evaluate((input) => input.files[0].name),
    "retained-room.glb",
  );
  // Space upload and detail dialogs have no category control
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).count(), 0);
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
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).count(), 0);
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog.getByLabel("Choose asset file").evaluate((input) => input.files[0].name),
    "test-room.glb",
  );
  // Space upload and detail dialogs have no category control
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).count(), 0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Only the adapter's confirmed pending result enters the list after successful submission
  await choose("Test response", "Normal");
  await page.getByRole("button", { name: "+ Add 3D Space", exact: true }).click();
  await dialog.getByLabel("Choose asset file").setInputFiles({
    name: "new-room.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from("local preview only"),
  });
  assert.equal(await dialog.getByRole("combobox", { name: "Filter Category" }).count(), 0);
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await page.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "new-room.glb", exact: true }) })
    .getByRole("button")
    .click();
  await dialog.getByText("Pending validation", { exact: true }).waitFor();
  // Approval needs explicit source, rights and content statements and applies only after confirmation
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await dialog
    .getByText("Complete the source, licence and content review before approval")
    .waitFor();
  await dialog
    .getByRole("textbox", { name: "Source or provenance" })
    .fill("Synthetic local preview");
  await dialog
    .getByRole("textbox", { name: "Redistribution licence" })
    .fill("Synthetic fixture only");
  await dialog
    .getByRole("textbox", { name: "Content review notes" })
    .fill("Preview review flow checked");
  await page.screenshot({ path: "test-results/scrum168/review.png", fullPage: true });
  // Long approval forms keep their footer reachable within the modal's own scroll area
  const reviewFooter = dialog.locator(".asset-admin-actions");
  await reviewFooter.scrollIntoViewIfNeeded();
  const footerBounds = await reviewFooter.boundingBox();
  const reviewBounds = await dialog.boundingBox();
  assert.ok(footerBounds.y + footerBounds.height <= reviewBounds.y + reviewBounds.height);
  await page.screenshot({ path: "test-results/scrum168/review-footer.png", fullPage: true });
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "new-room.glb", exact: true }) })
    .getByRole("button")
    .click();

  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  assert.equal(await dialog.locator(".asset-admin-detail-preview").count(), 0);
  assert.equal(await dialog.getByRole("textbox", { name: "Asset Type" }).count(), 0);
  assert.ok((await dialog.boundingBox()).width <= 440);

  await page.screenshot({ path: "test-results/scrum168/delete-confirmation.png", fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Cancel, close and Escape return to the same details instead of dismissing both steps
  await dialog.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Close asset details", exact: true }).click();
  await dialog.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await page.keyboard.press("Escape");
  await dialog.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();

  // Delete hides the record from the active list while retaining its administrative tombstone
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Remove from all projects and exhibitions" })
      .isChecked(),
    false,
  );
  await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "new-room.glb", exact: true }).count(), 0);

  // Ordinary deletion retains an admin-only record and leaves the destructive option off by default
  await page.getByRole("button", { name: /^Deleted \(/ }).click();
  // Expanding the preview must not clone a deleted record into the Deleted tab
  await page.locator(".asset-admin-preview-controls").evaluate((details) => {
    details.open = true;
  });
  await page.getByLabel("More sample assets", { exact: true }).check();
  await page.getByRole("button", { name: /^Deleted \(1\)/ }).click();
  assert.equal(await page.locator(".asset-admin-card").count(), 1);
  // Extra samples expose the same actions and retain changes without affecting their siblings
  await page.getByRole("button", { name: /^All Spaces \(/ }).click();
  const sampleCard = page.locator(".asset-admin-card").filter({
    has: page.getByRole("heading", { name: "test-room 1", exact: true }),
  });
  await sampleCard.getByRole("button").click();
  await dialog.getByRole("button", { name: "Hide", exact: true }).click();
  await sampleCard.getByRole("button").click();
  await dialog.getByRole("button", { name: "Show", exact: true }).click();
  await sampleCard.getByRole("button").click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).click();
  assert.equal(await sampleCard.count(), 0);
  await page.getByRole("button", { name: /^Deleted \(2\)/ }).click();
  assert.equal(await sampleCard.count(), 1);
  await page.getByLabel("More sample assets", { exact: true }).uncheck();
  await page.getByRole("button", { name: /^Deleted \(1\)/ }).click();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "new-room.glb", exact: true }) })
    .getByRole("button")
    .click();
  // Retained-use status must sit below the fixed field with a visible breathing gap
  const typeBounds = await dialog.getByRole("textbox", { name: "Asset Type" }).boundingBox();
  const statusBounds = await dialog.locator(".asset-admin-retired-status").first().boundingBox();
  assert.ok(statusBounds.y - (typeBounds.y + typeBounds.height) >= 11);
  const spaceCategory = dialog.getByRole("textbox", { name: "Filter Category", exact: true });
  assert.equal(await spaceCategory.inputValue(), "Not applicable");
  assert.equal(await spaceCategory.isDisabled(), true);
  const fieldRow = await dialog.locator(".asset-admin-fields").boundingBox();
  assert.ok(Math.abs((fieldRow.width - 16) / 2 - typeBounds.width) < 1);
  await page.screenshot({ path: "test-results/scrum168/deleted-details.png", fullPage: true });
  await dialog
    .getByRole("button", { name: "Remove from all projects and exhibitions", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Confirm Removal", exact: true }).waitFor();
  // Use equal spacing around the irreversible warning instead of offsetting individual elements
  const explanation = await dialog
    .locator(".asset-admin-confirmation-content > p")
    .first()
    .boundingBox();
  const warning = await dialog.locator(".asset-admin-confirmation-warning").boundingBox();
  const actions = await dialog.locator(".asset-admin-actions").boundingBox();
  assert.ok(Math.abs(warning.y - (explanation.y + explanation.height) - 16) < 1);
  assert.ok(Math.abs(actions.y - (warning.y + warning.height) - 16) < 1);
  await page.screenshot({ path: "test-results/scrum168/removal-confirmation.png", fullPage: true });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileRemoval = await dialog.boundingBox();
  assert.ok(mobileRemoval.x >= 0 && mobileRemoval.x + mobileRemoval.width <= 390);
  assert.ok(mobileRemoval.y >= 0 && mobileRemoval.y + mobileRemoval.height <= 844);
  await page.screenshot({ path: "test-results/scrum168/mobile-removal.png", fullPage: true });
  await page.setViewportSize(desktopViewport);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Cancelling removal retains the same details and its available follow-up action
  await dialog.getByRole("heading", { name: "new-room.glb", exact: true }).waitFor();
  await dialog
    .getByRole("button", { name: "Remove from all projects and exhibitions", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Confirm Removal", exact: true }).click();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "new-room.glb", exact: true }) })
    .getByRole("button")
    .click();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Remove from all projects and exhibitions", exact: true })
      .count(),
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /^All Spaces \(/ }).click();

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

  // Object and space libraries use the distinct layouts in the supplied admin PDF
  await choose("Test response", "Normal");
  await choose("Library", "Physical assets");
  await page.getByRole("heading", { name: "All Assets", exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".asset-admin-grid")
      .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length),
    4,
  );
  await page.locator(".asset-admin-preview-controls").evaluate((details) => {
    details.open = false;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".asset-admin-card").first().waitFor();
  await page
    .locator(".asset-admin-thumbnail img")
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await page.screenshot({ path: "test-results/scrum168/assets.png", fullPage: true });

  // Model dialogs keep their own asset type rather than inheriting the space form
  await page.locator(".asset-admin-card").first().getByRole("button").click();
  assert.equal(
    (await dialog.getByRole("textbox", { name: "Asset Type" }).inputValue()).trim(),
    "3D Model",
  );
  await checkDialogTypography();
  const fixedType = dialog.getByRole("textbox", { name: "Asset Type" });
  const fixedCategory = dialog.getByRole("combobox", { name: "Filter Category" });
  assert.equal(await fixedType.isDisabled(), true);
  assert.equal(await fixedCategory.isDisabled(), true);
  const appearance = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.color, style.backgroundColor, style.borderColor, style.opacity];
    });
  assert.deepEqual(await appearance(fixedType), await appearance(fixedCategory));

  await page.screenshot({ path: "test-results/scrum168/asset-details.png", fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Assets", exact: true }).click();
  assert.equal(await dialog.getByRole("textbox", { name: "Asset Type" }).count(), 0);
  await dialog.getByRole("heading", { name: "Upload 3D Model", exact: true }).waitFor();
  await checkDialogTypography();
  await page.screenshot({ path: "test-results/scrum168/add-asset.png", fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Custom menus keep Escape local and keep category choices specific to the asset type
  await page.getByRole("button", { name: "+ Add Assets", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Filter Category" }).click();
  assert.deepEqual(
    await page
      .getByRole("listbox", { name: "Filter Category" })
      .getByRole("option")
      .allTextContents(),
    ["Objects", "Furniture", "Architecture", "Clothing", "Tools & Equipment"],
  );
  await page.screenshot({ path: "test-results/scrum168/category-menu.png", fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.getByRole("listbox", { name: "Filter Category" }).isVisible(), false);
  await dialog.getByRole("combobox", { name: "Filter Category" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(
    (await dialog.getByRole("combobox", { name: "Filter Category" }).textContent()).trim(),
    "Furniture",
  );
  // Model intake asks only for the editable category; the current page already determines its type
  assert.equal(await dialog.getByRole("textbox", { name: "Asset Type" }).count(), 0);
  assert.equal(await dialog.getByRole("combobox", { name: "Asset Type" }).count(), 0);
  await dialog.getByRole("heading", { name: "Upload 3D Model", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const editableModelName = await page
    .locator(".asset-admin-card")
    .first()
    .getByRole("heading")
    .innerText();
  // Overflow belongs to the catalogue region, with no outer-page scrollbar
  await page.getByText("Local preview controls", { exact: true }).click();
  await page.getByLabel("More sample assets", { exact: true }).check();
  await page.locator(".asset-admin-card").nth(10).waitFor({ state: "attached" });
  // Sample records keep their own lifecycle even when their original asset was deleted
  assert.equal(
    (await page.locator(".asset-admin-card").filter({ hasText: "Snow globe 1" }).count()) > 0,
    true,
  );
  await page.getByRole("button", { name: /^Deleted \(/ }).click();
  assert.equal(
    await page.locator(".asset-admin-card").filter({ hasText: "Snow globe 1" }).count(),
    0,
  );
  await page.getByRole("button", { name: /^All Assets \(/ }).click();
  await page.locator(".asset-admin-preview-controls").evaluate((details) => {
    details.open = false;
  });
  assert.equal(
    await page
      .locator(".asset-admin-scroll")
      .evaluate((region) => region.scrollHeight > region.clientHeight),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true,
  );
  await page.screenshot({ path: "test-results/scrum168/internal-scroll.png", fullPage: true });

  // Narrow screens keep controls reachable without horizontal document overflow
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.body.scrollHeight <= innerHeight), true);
  await page.screenshot({ path: "test-results/scrum168/mobile.png", fullPage: true });
  // Mobile dialogs retain the same type scale and keep actions reachable inside their own scroll area
  await page.getByRole("button", { name: "+ Add Assets", exact: true }).click();
  await checkDialogTypography();
  const mobileDialog = await dialog.boundingBox();
  assert.ok(mobileDialog.x >= 0 && mobileDialog.x + mobileDialog.width <= 390);
  assert.ok(mobileDialog.y >= 0 && mobileDialog.y + mobileDialog.height <= 844);
  await page.screenshot({ path: "test-results/scrum168/mobile-upload.png", fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Keep the mobile opt-in explicit and retain the confirmed administrative record
  // Return to the original preview records before checking combined deletion and removal
  await page.getByText("Local preview controls", { exact: true }).click();
  await page.getByLabel("More sample assets", { exact: true }).uncheck();
  await page.locator(".asset-admin-preview-controls").evaluate((details) => {
    details.open = false;
  });
  await page.getByRole("heading", { name: editableModelName, exact: true }).waitFor();

  await page.locator(".asset-admin-card").first().getByRole("button").click();
  const removedName = await dialog.locator("h2").textContent();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  const force = dialog.getByRole("checkbox", { name: "Remove from all projects and exhibitions" });
  assert.equal(await force.isChecked(), false);
  const checkboxBefore = await force.boundingBox();
  await force.check();
  const checkboxAfter = await force.boundingBox();
  assert.ok(Math.abs(checkboxBefore.x - checkboxAfter.x) < 1);
  assert.ok(Math.abs(checkboxBefore.y - checkboxAfter.y) < 1);
  const removalBounds = await dialog.boundingBox();
  assert.ok(removalBounds.x >= 0 && removalBounds.x + removalBounds.width <= 390);
  assert.ok(removalBounds.y >= 0 && removalBounds.y + removalBounds.height <= 844);
  await page.screenshot({ path: "test-results/scrum168/mobile-delete.png", fullPage: true });
  await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).click();
  await page.getByRole("button", { name: /^Deleted \(/ }).click();
  await page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: removedName, exact: true }) })
    .getByRole("button")
    .click();
  await dialog.getByText("Removed from all projects and exhibitions.", { exact: true }).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Remove from all projects and exhibitions", exact: true })
      .count(),
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Account labels come from the preview identity and logout removes the active screen
  await page.getByText("Local preview controls", { exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Alex Tan");
  await page.locator(".asset-admin-account").getByText("Alex Tan", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".asset-admin-account").getByText("AT", { exact: true }).count(),
    1,
  );
  assert.equal(await page.locator("select").count(), 0);
  assert.equal(
    await page
      .locator(".asset-admin-scroll")
      .evaluate((region) => getComputedStyle(region, "::-webkit-scrollbar").width),
    "8px",
  );
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.getByRole("heading", { name: "Signed out", exact: true }).waitFor();
  const signedOut = page.locator(".asset-admin-denied");
  assert.equal(await signedOut.count(), 1);
  const alignment = await signedOut.evaluate((panel) => {
    const style = getComputedStyle(panel);
    return [style.alignItems, style.justifyContent, style.textAlign];
  });
  assert.deepEqual(alignment, ["center", "center", "center"]);
  await page.screenshot({ path: "test-results/scrum168/signed-out.png", fullPage: true });

  assert.equal(await page.locator(".asset-admin-grid").count(), 0);

  assert.deepEqual(errors, []);
  console.log(
    "PASS: asset administration search, submission recovery, authoritative state, role gating, confirmation and keyboard/mobile checks",
  );
} catch (error) {
  await page.screenshot({ path: "test-results/scrum168/failure.png", fullPage: true });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
