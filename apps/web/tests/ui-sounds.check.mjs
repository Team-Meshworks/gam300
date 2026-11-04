import { launchPersistentBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";

const origin = (process.argv[2] ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const context = await launchPersistentBrowser({
  target: origin,
  args: ["--enable-unsafe-swiftshader"],
});

try {
  // Record the sounds the page really asks the browser to play
  await context.addInitScript(() => {
    // Kept in sessionStorage so sounds heard before leaving a page are not lost with it
    window.heard = () => JSON.parse(sessionStorage.getItem("sounds") ?? "[]");
    window.forget = () => sessionStorage.removeItem("sounds");
    window.cancelPicker = false;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const name = new URL(this.src).pathname
        .split("/")
        .pop()
        .replace(/-[\w-]{8}\.wav$/, ".wav");
      sessionStorage.setItem("sounds", JSON.stringify([...window.heard(), name]));
      return play.call(this);
    };
    window.showSaveFilePicker = async () => {
      if (window.cancelPicker) throw new DOMException("Cancelled", "AbortError");
      return (await navigator.storage.getDirectory()).getFileHandle("sounds.json", {
        create: true,
      });
    };
  });
  const errors = [];

  async function played(page, expected, message) {
    // Sounds start straight after the click, a short wait lets any late one show up
    await page.waitForTimeout(250);
    const heard = await page.evaluate(() => {
      const names = window.heard();
      window.forget();
      return names;
    });
    assert.deepEqual(heard, expected, message);
  }
  const forget = (page) => page.evaluate(() => window.forget());

  // Entry pages
  const entry = await context.newPage();
  entry.on("pageerror", (error) => errors.push(error.message));
  await entry.route("**/api/auth/session", (route) => route.fulfill({ status: 401 }));
  await entry.goto(`${origin}/login`);
  await entry.getByRole("link", { name: /back to home/i }).click();
  await entry.waitForURL("**/landing");
  await played(entry, ["going-back.wav"], "Back to home plays Going Back");
  await entry.goto(`${origin}/login`);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    entry.getByRole("link", { name: /back to home/i }).click({ modifiers: ["Control"] }),
  ]);
  assert.equal(new URL(entry.url()).pathname, "/login", "Ctrl-click keeps the page");
  await tab.close();
  await entry.close();

  // Editor
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${origin}/`);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
  await forget(page);

  // Rooms are placed from their own tray; object cards retain the library selection sound
  await page.getByRole("button", { name: "Third person", exact: true }).click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page
    .getByRole("group", { name: "Rooms options", exact: true })
    .getByRole("button", { name: "test-room", exact: true })
    .click();
  await forget(page);
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  await played(page, ["asset-place.wav"], "Placing a room plays Asset Place");

  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "test-crate", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await played(page, ["asset-select.wav"], "Picking an object card plays Asset Select");
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  await played(page, ["asset-place.wav"], "Placing an object plays Asset Place");
  await forget(page);

  await page.keyboard.press("Delete");
  await played(page, ["delete.wav"], "Deleting the selected object plays Delete");
  await page.keyboard.press("Delete");
  await played(page, [], "A delete with nothing selected stays silent");

  // Save, then a cancelled Save As
  const menu = async (name) => {
    await page.locator(".draft-menu summary").click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  await menu("Save");
  await page.waitForFunction(
    () => document.querySelector(".save-state .sr-only")?.textContent === "Saved",
  );
  await played(page, ["save.wav"], "A finished save plays Save");
  await page.evaluate(() => (window.cancelPicker = true));
  await menu("Save As");
  await played(page, [], "A cancelled save stays silent");
  await page.evaluate(() => (window.cancelPicker = false));

  // Preview
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await played(page, ["enter-preview.wav"], "Preview plays Enter Preview Mode");
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await played(page, ["going-back.wav"], "Exit preview plays Going Back");

  // Unsaved changes dialog
  await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page
    .locator(".asset-picker")
    .getByRole("button", { name: "test-crate", exact: true })
    .click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await played(page, ["asset-select.wav"], "Picking an object card plays Asset Select");
  await page.locator(".viewport-stage").click({ position: { x: 500, y: 300 } });
  await played(page, ["asset-place.wav"], "Placing an object plays Asset Place");
  await forget(page);
  await menu("New");
  await page.getByRole("dialog").waitFor();
  await played(page, ["warning.wav"], "The unsaved changes dialog plays Warning");

  assert.deepEqual(errors, [], "No page errors");
  console.log(
    "PASS: sounds for going back, asset select and place, delete, save, preview and the unsaved changes warning, with silence when an action fails or is cancelled",
  );
} finally {
  await context.close();
}
