import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5182/ui-preview.html";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  const classes = page.getByRole("link", { name: "Classes", exact: true });
  assert.equal(await classes.count(), 1, "Classes navigation should be available");
  await classes.focus();
  await page.keyboard.press("Enter");
  assert.equal(new URL(page.url()).hash, "#classes");
  await page.getByRole("heading", { name: "Class assignments" }).waitFor();
  const outcome = page.getByLabel("Assignment outcome");
  const form = page.getByRole("form", { name: "Class assignment" });
  const project = form.getByLabel(/^Project/);
  const classSelect = form.getByLabel(/^Class/);
  const search = form.getByLabel("Search students");
  const assign = form.getByRole("button", { name: "Assign class" });
  assert.equal(await outcome.inputValue(), "unavailable");
  assert.equal(await assign.isDisabled(), true);
  await outcome.selectOption("success");
  await page
    .getByRole("form", { name: "Class assignment" })
    .evaluate((form) => form.requestSubmit());
  assert.equal(await page.getByText("Simulated assignments: 0").isVisible(), true);
  await project.selectOption({ label: "The Silk Road: A Journey Through History" });
  await classSelect.selectOption("4A");
  await page
    .getByRole("form", { name: "Class assignment" })
    .evaluate((form) => form.requestSubmit());
  assert.equal(await page.getByText("Simulated assignments: 0").isVisible(), true);
  await search.focus();
  await page.keyboard.type("Aisyah");
  await page.getByRole("button", { name: "Select all" }).click();
  await search.fill("");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Christopher Low/ }).isChecked(), false);
  await page.getByRole("tab", { name: /Selected/ }).click();
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Christopher Low/ }).count(), 0);
  await search.fill("Aisyah");
  await classSelect.selectOption("4B");
  assert.equal(await search.inputValue(), "");
  assert.equal(
    await page.getByRole("tab", { name: /All students/ }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await page.getByRole("checkbox", { name: /Song Yu Qian/ }).isChecked(), false);
  await classSelect.selectOption("4A");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), false);
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  await project.selectOption({ label: "Our Natural World" });
  assert.equal(await classSelect.inputValue(), "");
  await classSelect.selectOption("4A");
  assert.equal(await search.inputValue(), "");
  assert.equal(await form.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), false);
  await project.selectOption({ label: "The Silk Road: A Journey Through History" });
  await classSelect.selectOption("4A");
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  await assign.click();
  assert.equal(await search.isDisabled(), true);
  await page
    .getByRole("form", { name: "Class assignment" })
    .evaluate((form) => form.requestSubmit());
  await page.getByText(/Assigned in simulation/i).waitFor();
  assert.equal(await page.getByText("Simulated assignments: 1").isVisible(), true);
  const receipt = page
    .getByRole("status")
    .filter({ has: page.getByRole("heading", { name: "Assigned in simulation" }) });
  for (const text of ["The Silk Road: A Journey Through History", "Class 4A", "Aisyah"])
    assert.equal(await receipt.getByText(text, { exact: true }).isVisible(), true);
  await outcome.selectOption("rejected");
  await project.selectOption({ label: "The Silk Road: A Journey Through History" });
  await classSelect.selectOption("4A");
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  await assign.click();
  await page
    .getByText(/rejected/i)
    .last()
    .waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(await assign.isEnabled(), true);
  await assign.click();
  await page.getByText("Simulated assignments: 2").waitFor();
  await form.getByRole("alert").waitFor();
  assert.equal(await assign.isEnabled(), true);
  await outcome.selectOption("unknown");
  await project.selectOption({ label: "The Silk Road: A Journey Through History" });
  await classSelect.selectOption("4A");
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  await assign.click();
  await form
    .getByRole("alert")
    .filter({ hasText: /outcome is unknown/i })
    .waitFor();
  assert.equal(await assign.isDisabled(), true);
  assert.equal(await search.isDisabled(), true);
  await page.getByRole("button", { name: "Reset assignment simulation" }).click();
  assert.equal(await project.inputValue(), "");
  for (const width of [1366, 1024, 768]) {
    await page.setViewportSize({ width, height: 768 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `No overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await mkdir("../../.artifacts/ui-foundation", { recursive: true });
  await page.screenshot({
    path: "../../.artifacts/ui-foundation/preview-class-assignment.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log("Class assignment browser checks passed");
} finally {
  await browser.close();
}
