import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:8081/";
const useFileTransfer = () => {
  window.showOpenFilePicker = undefined;
  window.showSaveFilePicker = undefined;
};
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.addInitScript(useFileTransfer);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  assert.ok(response.headers()["content-security-policy"], "The real server applies its policy");
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator("canvas").count(), 1);
  const asset = page.getByRole("button", { name: "Add test-crate", exact: true });
  assert.ok(
    await asset.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await asset.click();
  assert.equal(await page.locator(".object-row").count(), 1);
  if (process.env.CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.CHECK_SCREENSHOT });
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".object-row").count(), 0);
  await page.getByRole("button", { name: "Add test-room", exact: true }).click();
  await asset.click();
  const originalPosition = await page.getByLabel("Selected position").textContent();
  // No more move buttons, so nudge through the Position panel then go back to the tree
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const field = page.getByRole("textbox", { name: /transform X \(m\)$/ });
  await field.fill(String(Number(await field.inputValue()) + 0.25));
  await field.press("Enter");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  const movedPosition = await page.getByLabel("Selected position").textContent();
  assert.notEqual(movedPosition, originalPosition);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.getByLabel("Selected position").textContent(), originalPosition);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.locator(".draft-menu summary").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloading;
  assert.match(download.suggestedFilename(), /^spatia-.*\.json$/);
  const bytes = readFileSync(await download.path());
  if (process.env.CHECK_PROJECT) await download.saveAs(process.env.CHECK_PROJECT);
  const project = JSON.parse(bytes.toString("utf8"));
  assert.equal(project.scenes[0].environmentAssetId, "test-room-v1");
  assert.equal(project.scenes[0].objects.length, 1);
  assert.deepEqual(project.scenes[0].objects[0].transform.position, [0.25, 0, 0]);
  // Save finishes its recovery write before restoring the file-status label
  await page.getByText("Not saved", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Reopened your last project", { exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  assert.equal(await page.locator(".object-row").count(), 1);
  await page.locator(".object-row").first().click();
  assert.equal(await page.getByLabel("Selected position").textContent(), movedPosition);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.getByLabel("Selected position").textContent(), originalPosition);
  const fresh = await browser.newPage();
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.addInitScript(useFileTransfer);
  await fresh.goto(url);
  await fresh.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await fresh.locator(".draft-menu summary").click();
  const choosing = fresh.waitForEvent("filechooser");
  await fresh.getByRole("button", { name: "Open", exact: true }).click();
  await (
    await choosing
  ).setFiles({ name: "project.json", mimeType: "application/json", buffer: bytes });
  await fresh.getByText("Project opened", { exact: true }).waitFor();
  assert.equal(await fresh.locator(".object-row").count(), 1);
  assert.equal(
    await fresh.locator(".object-row").first().getAttribute("data-object-id"),
    project.scenes[0].objects[0].id,
  );
  await fresh.locator(".object-row").first().click();
  assert.equal(await fresh.getByLabel("Selected position").textContent(), movedPosition);
  assert.deepEqual(errors, [], "Models and embedded textures load under the deployed policy");
  console.log(
    "PASS: packaged editor, server policy, assets, place/move/undo, JSON Save/Open, reload and recovered undo",
  );
} finally {
  await browser.close();
}
