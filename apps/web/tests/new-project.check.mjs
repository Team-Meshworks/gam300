import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5180/ui-preview.html#new-project",
});
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5180/ui-preview.html#new-project";

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByLabel("Submission outcome").waitFor();

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=",
    "base64",
  );
  const imageFile = (name) => ({ name, mimeType: "image/png", buffer: png });
  const picker = page.getByLabel("Choose cover image");
  const gallery = page.getByRole("button", { name: "Gallery" });
  const cover = page.getByRole("img", { name: "Selected cover image" });
  const coverOption = page.getByRole("radio", { name: "Cover image" }).locator("..");
  const panoramaOption = page.getByRole("radio", { name: "360°" }).locator("..");
  const [coverBox, galleryBox, panoramaBox] = await Promise.all(
    [coverOption, gallery, panoramaOption].map((element) => element.boundingBox()),
  );
  assert.ok(coverBox && galleryBox && panoramaBox, "Image type controls are visible");
  for (const box of [galleryBox, panoramaBox]) {
    assert.ok(Math.abs(box.y - coverBox.y) < 1, "Image type controls share a row");
    assert.ok(Math.abs(box.width - coverBox.width) < 1, "Image type controls have equal widths");
  }
  for (const box of [coverBox, galleryBox, panoramaBox]) {
    assert.ok(Math.abs(box.height - 52) < 1, "Image type controls are 52px tall");
  }
  assert.ok(Math.abs(galleryBox.x - (coverBox.x + coverBox.width) - 12) < 1);
  assert.ok(Math.abs(panoramaBox.x - (galleryBox.x + galleryBox.width) - 12) < 1);
  assert.equal(await page.getByRole("radio", { name: "Gallery" }).count(), 0);
  assert.equal(await page.getByRole("radio", { name: "Cover image" }).isChecked(), true);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), gallery.click()]);
  await chooser.setFiles(imageFile("first.png"));
  await cover.waitFor({ state: "visible" });
  const firstSource = await cover.getAttribute("src");
  await picker.setInputFiles(imageFile("replacement.png"));
  await page.waitForFunction((source) => {
    const image = document.querySelector('img[alt="Selected cover image"]');
    return image && image.getAttribute("src") !== source;
  }, firstSource);
  await page.getByRole("radio", { name: "360°" }).check();
  assert.equal(await cover.isVisible(), false);
  const [chooserFrom360] = await Promise.all([page.waitForEvent("filechooser"), gallery.click()]);
  await chooserFrom360.setFiles(imageFile("from-360.png"));
  assert.equal(await page.getByRole("radio", { name: "Cover image" }).isChecked(), true);
  assert.equal(await cover.isVisible(), true);
  const [cancelledChooser] = await Promise.all([page.waitForEvent("filechooser"), gallery.click()]);
  await cancelledChooser.setFiles([]);
  assert.equal(await cover.isVisible(), true, "Cancelling preserves the selected cover");
  await page.getByRole("button", { name: "Remove cover image" }).click();
  assert.equal(await cover.count(), 0);
  await picker.setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid"),
  });
  await page.getByRole("alert").waitFor({ state: "visible" });
  assert.equal(await cover.count(), 0);
  await picker.setInputFiles(imageFile("again.png"));
  await cover.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Reset simulation" }).click();
  assert.equal(await cover.count(), 0);
  assert.equal(await picker.inputValue(), "");

  const outcome = page.getByLabel("Submission outcome");
  await outcome.waitFor();
  assert.equal(await outcome.inputValue(), "unavailable");
  const create = page.getByRole("button", { name: "Create project" });
  assert.equal(await create.isDisabled(), true);

  await page.getByLabel("Project title").fill("A project for review");
  await page.getByLabel("Project description").fill("A description");
  await page.getByLabel("Project instructions").fill("Follow the instructions");
  await page.getByLabel("Due date").fill("2026-12-01");
  await page
    .getByRole("group", { name: "New project details" })
    .getByLabel(/^Class/)
    .selectOption("4A");
  await page.getByLabel("Search students").fill("Aisyah");
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByLabel("Search students").fill("");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Christopher Low/ }).isChecked(), false);
  assert.equal(await create.isDisabled(), true, "Unavailable must not create a project");

  await page.getByRole("tab", { name: /Selected/ }).click();
  await page.getByLabel("Search students").fill("Aisyah");
  await page
    .getByRole("group", { name: "New project details" })
    .getByLabel(/^Class/)
    .selectOption("4B");
  assert.equal(await page.getByLabel("Search students").inputValue(), "");
  assert.equal(
    await page.getByRole("tab", { name: /All students/ }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).count(), 0);
  assert.equal(await page.getByRole("checkbox", { name: /Song Yu Qian/ }).isChecked(), false);
  await page
    .getByRole("group", { name: "New project details" })
    .getByLabel(/^Class/)
    .selectOption("4A");
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();

  await outcome.selectOption("success");
  async function fillProject() {
    await page.getByLabel("Project title").fill("A project for review");
    await page.getByLabel("Project description").fill("A description");
    await page.getByLabel("Project instructions").fill("Follow the instructions");
    await page.getByLabel("Due date").fill("2026-12-01");
    await page
      .getByRole("group", { name: "New project details" })
      .getByLabel(/^Class/)
      .selectOption("4A");
    await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  }
  await fillProject();
  assert.equal(await create.isEnabled(), true);
  await create.click();
  const creating = page.getByRole("button", { name: "Creating…" });
  assert.equal(await creating.isDisabled(), true);
  assert.equal(await page.getByLabel("Project title").isDisabled(), true);
  assert.equal(await page.getByLabel("Search students").isDisabled(), true);
  assert.equal(await gallery.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
  await creating.evaluate((button) => button.closest("form").requestSubmit());
  await page.getByText("Project created in simulation").waitFor();
  assert.equal(await page.getByText("Simulated requests: 1").isVisible(), true);
  assert.equal(await page.getByLabel("Project title").inputValue(), "A project for review");

  await outcome.selectOption("rejected");
  await fillProject();
  await create.click();
  await page.getByText("Simulation: creation was rejected. Your details are unchanged.").waitFor();
  assert.equal(await page.getByLabel("Project title").inputValue(), "A project for review");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(await create.isEnabled(), true, "Rejected submission can be retried manually");
  await create.click();
  await page.getByText("Simulation: creation was rejected. Your details are unchanged.").waitFor();
  assert.equal(await page.getByText("Simulated requests: 2").isVisible(), true);

  await outcome.selectOption("unknown");
  await fillProject();
  await create.click();
  await page
    .getByRole("alert")
    .filter({ hasText: /outcome.*unknown/i })
    .waitFor();
  assert.equal(await create.isDisabled(), true);
  assert.equal(await page.getByLabel("Project title").isDisabled(), true);
  assert.equal(await page.getByLabel("Project title").inputValue(), "A project for review");
  await outcome.selectOption("success");
  await fillProject();
  assert.equal(await create.isEnabled(), true, "Changing the simulation permits another try");
  assert.deepEqual(errors, []);
  console.log("New project browser checks passed");
} finally {
  await browser.close();
}
