import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch();
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5180/ui-preview.html#new-project";

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);

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
