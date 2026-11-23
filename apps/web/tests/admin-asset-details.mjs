import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function captureAdminPreview(page, name, target = page) {
  const dir = process.env.SPATIA_ADMIN_PREVIEW_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await target.screenshot({ path: join(dir, name + ".png"), animations: "disabled" });
}

export async function checkAdminAssets(page, origin) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/assets");
  const dialog = page.getByRole("dialog");
  const nameField = dialog.getByRole("textbox", { name: "Asset name", exact: true });
  const save = dialog.getByRole("button", { name: "Save Changes", exact: true });
  const card = (name) =>
    page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const file = (name) => resolve("../../assets/delivery", name);
  async function choose(label, name) {
    await dialog.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  }
  async function upload(filename, name, preview = false) {
    await page.getByRole("button", { name: "+ Add Assets", exact: true }).click();
    await dialog.getByLabel("Choose asset file").setInputFiles(file(filename));
    assert.equal(await nameField.inputValue(), filename.replace(/\.[^.]+$/, ""));
    await nameField.fill(name);
    if (preview) await captureAdminPreview(page, "asset-upload", dialog);
    await save.click();
    await card(name).waitFor();
  }
  await upload("test-crate.glb", "Handling Crate");
  await upload("modern-bench-2.glb", "Gallery Bench", true);
  await card("Gallery Bench").getByRole("link", { name: "Gallery Bench" }).click();
  assert.ok(await nameField.evaluate((input) => input === document.activeElement));
  await nameField.fill("North Gallery Bench");
  await choose("Filter Category", "Furniture");
  await captureAdminPreview(page, "asset-edit", dialog);
  const updated = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.endsWith("/details"),
  );
  await save.click();
  const editResponse = await updated;
  const editResult = await editResponse.json();
  assert.equal(editResponse.status(), 200, editResult.code);
  assert.equal(editResult.name, "North Gallery Bench");
  await card("North Gallery Bench").waitFor();
  await page.reload();
  await card("North Gallery Bench")
    .getByRole("button", { name: /View details/ })
    .click();
  assert.equal(
    (await dialog.getByRole("button", { name: "Edit filter category" }).innerText()).trim(),
    "Furniture",
  );
  await dialog.getByRole("button", { name: "Edit asset type" }).click();
  assert.ok(
    await dialog
      .getByRole("combobox", { name: "Asset Type" })
      .evaluate((button) => button === document.activeElement),
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await card("Handling Crate").getByRole("link", { name: "3D Model" }).click();
  await choose("Asset Type", "Audio");
  assert.ok(await save.isDisabled());
  const replacement = dialog.getByLabel("Choose asset file");
  assert.equal(await replacement.getAttribute("accept"), ".m4a");
  await replacement.setInputFiles(file("audio/calm-piano.m4a"));
  await nameField.fill("Gallery Soundtrack");
  await save.click();
  await card("Gallery Soundtrack").getByRole("link", { name: "Audio" }).waitFor();
  assert.equal(await card("Handling Crate").count(), 0);

  for (const name of ["North Gallery Bench", "Gallery Soundtrack"]) {
    await card(name)
      .getByRole("button", { name: /View details/ })
      .click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm Delete", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "Deleted (3)", exact: true }).click();
  const select = (name) => page.getByRole("checkbox", { name: "Select " + name, exact: true });
  await select("all visible assets").check();
  await select("Gallery Soundtrack").uncheck();
  await captureAdminPreview(page, "deleted-assets");
  const remove = page.getByRole("button", { name: "Delete selected", exact: true });
  await remove.click();
  assert.equal(await dialog.getByRole("listitem").count(), 2);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(await select("Handling Crate").isChecked());
  await remove.click();
  await captureAdminPreview(page, "confirm-bulk-delete", dialog);

  // Reject the second write once. Retrying must only send the still-actionable asset.
  const removals = [];
  await page.route(/\/removals\/[0-9a-f-]+$/, (route) => {
    removals.push(new URL(route.request().url()).pathname.split("/").at(-3));
    return removals.length === 2 ? route.fulfill({ status: 429, json: {} }) : route.continue();
  });
  await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await dialog.getByText("1 of 2 permanently deleted.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(removals.length, 3);
  assert.notEqual(removals[0], removals[1]);
  assert.equal(removals[1], removals[2]);
  await page.reload();
  await page.getByRole("button", { name: "Deleted (3)", exact: true }).click();
  await card("Handling Crate").getByText("Permanently deleted", { exact: true }).waitFor();
  await card("North Gallery Bench").getByText("Permanently deleted", { exact: true }).waitFor();
  assert.ok(await select("Gallery Soundtrack").isEnabled());
}
