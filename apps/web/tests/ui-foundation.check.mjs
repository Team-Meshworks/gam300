import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch();
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5180/ui-preview.html";

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "UI foundation" }).waitFor();

  const newProject = page.getByRole("link", { name: "New project", exact: true });
  await newProject.focus();
  await page.keyboard.press("Enter");
  const preview = page.getByRole("button", { name: "Preview project" });
  await preview.click();
  assert.equal(await page.getByRole("dialog").count(), 0, "Required fields block an empty preview");
  await page.getByLabel("Project title").fill("A project for review");
  await page.getByLabel("Project description").fill("A description");
  await page.getByLabel("Project instructions").fill("Follow the instructions");
  await page.getByLabel("Due date").fill("2026-12-01");
  await page
    .getByRole("group", { name: "New project details" })
    .getByLabel(/^Class/)
    .selectOption({ index: 1 });
  await page.getByLabel("Search students").fill("Aisyah");
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  assert.equal(await page.getByRole("checkbox", { name: /Christopher Low/ }).count(), 0);
  await page.getByLabel("Search students").fill("");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  await page.getByRole("tab", { name: /Selected/ }).click();
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Christopher Low/ }).count(), 0);
  await page.getByRole("tab", { name: /All students/ }).click();

  await preview.click();
  const dialog = page.getByRole("dialog", { name: "Project preview" });
  await dialog.waitFor();
  assert.equal(await dialog.getByText("A project for review").isVisible(), true);
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Tab");
    assert.equal(await newProject.evaluate((node) => node === document.activeElement), false);
  }
  await newProject.focus();
  assert.equal(await newProject.evaluate((node) => node === document.activeElement), false);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await preview.evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.getByLabel("Project title").inputValue(), "A project for review");
  await preview.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  assert.equal(await preview.evaluate((node) => node === document.activeElement), true);

  await page.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByLabel("Your review").fill("Helpful feedback");
  await page.getByRole("button", { name: "Preview review" }).click();
  assert.equal(await page.getByRole("dialog").getByText("Helpful feedback").isVisible(), true);
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Accounts", exact: true }).click();
  const accounts = page.getByRole("tabpanel", { name: /Students|Teachers|All/ });
  const allTab = page.getByRole("tab", { name: "All", exact: true });
  const studentsTab = page.getByRole("tab", { name: "Students", exact: true });
  const teachersTab = page.getByRole("tab", { name: "Teachers", exact: true });
  await allTab.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await studentsTab.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("End");
  assert.equal(await teachersTab.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await studentsTab.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Home");
  assert.equal(await allTab.evaluate((node) => node === document.activeElement), true);
  await studentsTab.click();
  assert.equal(await accounts.getByText("Aisyah", { exact: true }).isVisible(), true);
  assert.equal(await accounts.getByText("Ms Tan", { exact: true }).count(), 0);
  await page.getByRole("tab", { name: "Teachers", exact: true }).click();
  assert.equal(await accounts.getByText("Ms Tan", { exact: true }).isVisible(), true);
  await page.getByRole("tab", { name: "All", exact: true }).click();
  await page.getByLabel("Search accounts").fill("Aisyah");
  assert.equal(await accounts.getByText("Aisyah", { exact: true }).isVisible(), true);
  assert.equal(await accounts.getByText("Ms Tan", { exact: true }).count(), 0);

  await page.getByLabel("Example state").selectOption({ label: "Loading" });
  assert.equal(await page.getByRole("status").getByText("Loading…").isVisible(), true);
  await page.getByLabel("Example state").selectOption({ label: "Empty" });
  assert.equal(await page.getByRole("status").getByText("Nothing to show yet").isVisible(), true);
  await page.getByLabel("Example state").selectOption({ label: "Error" });
  await page.getByRole("button", { name: "Retry" }).click();
  assert.equal(await page.getByLabel("Example state").inputValue(), "ready");
  await page.getByLabel("Example state").selectOption({ label: "Disabled" });
  assert.equal(await page.getByLabel("Search accounts").isDisabled(), true);
  await page.getByLabel("Example state").selectOption({ label: "Ready" });
  await page.getByRole("link", { name: "New project", exact: true }).click();
  assert.equal(await page.getByLabel("Project title").inputValue(), "A project for review");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);

  for (const view of ["New project", "Review", "Accounts"]) {
    await page.getByRole("link", { name: view, exact: true }).click();
    await page
      .getByRole("heading", {
        name: { "New project": "New Project", Review: "Submission review", Accounts: "Accounts" }[
          view
        ],
        exact: true,
      })
      .waitFor();
    for (const width of [1366, 1024, 768]) {
      await page.setViewportSize({ width, height: 768 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${view} at ${width}px should not overflow horizontally`,
      );
    }
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  const screenshots = fileURLToPath(new URL("../../../.artifacts/ui-foundation/", import.meta.url));
  await mkdir(screenshots, { recursive: true });
  for (const view of ["New project", "Review", "Accounts"]) {
    await page.getByRole("link", { name: view, exact: true }).click();
    await page
      .getByRole("heading", {
        name: { "New project": "New Project", Review: "Submission review", Accounts: "Accounts" }[
          view
        ],
        exact: true,
      })
      .waitFor();
    await page.screenshot({
      path: `${screenshots}/preview-${view.toLowerCase().replace(" ", "-")}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log("UI foundation browser checks passed");
} finally {
  await browser.close();
}
