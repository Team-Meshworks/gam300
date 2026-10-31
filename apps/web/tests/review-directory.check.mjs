import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5182/ui-preview.html");
  await page.getByRole("link", { name: "Review", exact: true }).click();
  assert.equal(
    await page.getByLabel("Review outcome").count(),
    1,
    "Review simulation must offer an outcome control",
  );
  const outcome = page.getByLabel("Review outcome");
  const state = page.getByLabel("Submission state");
  const feedback = page.getByLabel("Your review");
  const save = page.getByRole("button", { name: "Save review" });
  const approve = page.getByRole("button", { name: "Approve to publish" });
  assert.equal(await outcome.inputValue(), "unavailable");
  await feedback.fill("Useful feedback");
  assert.equal(await save.isDisabled(), true);
  assert.equal(await approve.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Publish project" }).isDisabled(), true);
  await outcome.selectOption("success");
  await feedback.fill("Useful feedback");
  await save.evaluate((button) => {
    button.click();
    button.click();
  });
  assert.equal(await save.isDisabled(), true, "Pending request must lock duplicate actions");
  assert.equal(await feedback.isDisabled(), true);
  await page.getByText("Review saved.").waitFor();
  assert.equal(await page.getByText("Simulated requests: 1").isVisible(), true);
  assert.equal(
    await page.getByText(/save-review · sample-submission · revision 1/).isVisible(),
    true,
  );
  await approve.click();
  await page.getByText("Teacher approval confirmed.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Publish project" }).isDisabled(), true);
  await outcome.selectOption("rejected");
  await feedback.fill("Keep this feedback");
  await save.click();
  await page
    .getByRole("alert")
    .filter({ hasText: /rejected/i })
    .waitFor();
  assert.equal(await feedback.inputValue(), "Keep this feedback");
  assert.equal(await save.isEnabled(), true);
  await outcome.selectOption("unknown");
  await feedback.fill("Preserve uncertain feedback");
  await save.click();
  await page
    .getByRole("alert")
    .filter({ hasText: /outcome could not be confirmed/i })
    .waitFor();
  assert.equal(await feedback.inputValue(), "Preserve uncertain feedback");
  assert.equal(await save.isDisabled(), true);
  assert.equal(await approve.isDisabled(), true);
  await outcome.selectOption("success");
  await state.selectOption("editing");
  await page.getByRole("button", { name: "Mark as completed" }).click();
  await page.getByText("Completion confirmed.").waitFor();
  await page.getByRole("button", { name: "Send to teacher" }).click();
  await page.getByText("Submission confirmed.").waitFor();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: "Submission confirmed." })
      .evaluate((node) => node === document.activeElement),
    true,
    "Focus moves to confirmation when the submit button disappears",
  );
  assert.equal(await page.getByRole("button", { name: "Publish project" }).isDisabled(), true);
  for (const width of [1366, 1024, 768]) {
    await page.setViewportSize({ width, height: 768 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Review at ${width}px must not overflow`,
    );
  }
  const screenshots = fileURLToPath(new URL("../../../.artifacts/ui-foundation/", import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: `${screenshots}/review-simulation.png`, fullPage: true });

  await page.getByRole("link", { name: "Accounts", exact: true }).click();
  await page.screenshot({ path: `${screenshots}/organisation-list.png`, fullPage: true });
  const orgSearch = page.getByLabel("Search organisations");
  await orgSearch.fill("Ridgeview");
  assert.equal(
    await page.getByRole("button", { name: "Open Lakeside Secondary School" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.screenshot({ path: `${screenshots}/ridgeview-detail.png`, fullPage: true });
  const accounts = page.getByRole("tabpanel", { name: /Students|Teachers|All/ });
  await page.getByLabel("Search accounts").fill("Aisyah");
  assert.equal(await accounts.getByText("Aisyah", { exact: true }).isVisible(), true);
  await page.getByRole("button", { name: "View account for Aisyah" }).click();
  assert.equal(
    await page.getByRole("dialog").getByText("Aisyah", { exact: true }).isVisible(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Teachers", exact: true }).click();
  await page.getByRole("button", { name: "All organisations" }).click();
  assert.equal(await orgSearch.inputValue(), "Ridgeview");
  await orgSearch.fill("");
  await page.getByRole("button", { name: "Open Lakeside Secondary School" }).click();
  assert.equal(await page.getByLabel("Search accounts").inputValue(), "");
  assert.equal(
    await page.getByRole("tab", { name: "All", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await accounts.getByText("Aisyah", { exact: true }).count(),
    0,
    "Accounts must stay in their organisation",
  );
  assert.equal(await accounts.getByText("Alex Chen", { exact: true }).isVisible(), true);
  for (const width of [1366, 1024, 768]) {
    await page.setViewportSize({ width, height: 768 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Directory at ${width}px must not overflow`,
    );
  }
  await page.screenshot({ path: `${screenshots}/preview-directory.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Review and directory browser checks passed");
} finally {
  await browser.close();
}
