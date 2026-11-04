import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const required = [
  "SPATIA_API_ORIGIN",
  "SPATIA_TEST_EDUCATOR",
  "SPATIA_TEST_STUDENT",
  "SPATIA_TEST_OUTSIDER",
  "SPATIA_TEST_CLASS",
  "SPATIA_TEST_SOURCE",
];
for (const name of required) assert.ok(process.env[name], `Missing ${name}`);
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const origin = `https://127.0.0.1:${server.httpServer.address().port}`;
let browser;
async function login(context, name) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`${origin}/login`);
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "Go to projects" }).click();
  return page;
}
try {
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const teacher = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
  });
  const page = await login(teacher, process.env.SPATIA_TEST_EDUCATOR);
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  await page.getByLabel("Source project").selectOption(process.env.SPATIA_TEST_SOURCE);
  await page.getByLabel("Project title").fill("Live class assignment");
  await page.getByLabel("Project description").fill("Independent exhibit");
  await page.getByLabel("Project instructions").fill("Explain each exhibit.");
  await page.getByLabel("Due date and time").fill("2026-12-01T15:30");
  await page.getByLabel(/^Class/).selectOption(process.env.SPATIA_TEST_CLASS);
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) }).check();
  const response = page.waitForResponse(
    (item) => item.url().endsWith("/assignments") && item.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project" }).click();
  const receiptResponse = await response;
  assert.equal(receiptResponse.status(), 201);
  const receipt = await receiptResponse.json();
  assert.equal(receipt.projects.length, 1);
  const project = receipt.projects[0].projectId;
  await page.getByRole("heading", { name: "Live class assignment" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Class", exact: true })
    .selectOption(process.env.SPATIA_TEST_CLASS);
  await page.getByRole("button", { name: "Live class assignment", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Open project for ${process.env.SPATIA_TEST_STUDENT}`,
      exact: true,
    })
    .waitFor();
  const studentContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
  });
  const student = await login(studentContext, process.env.SPATIA_TEST_STUDENT);
  await student.getByRole("button", { name: "Classes", exact: true }).click();
  await student.getByRole("button", { name: "Live class assignment", exact: true }).click();
  await student.getByText("Explain each exhibit.", { exact: true }).waitFor();
  await student.getByRole("button", { name: "Open your project", exact: true }).click();
  await student.waitForURL(`**/?projectId=${project}`);
  await student.getByRole("button", { name: "Scenes", exact: true }).click();
  await student.getByLabel("Scene name", { exact: true }).fill("Saved by student");
  const savedResponse = student.waitForResponse(
    (item) => item.url().endsWith(`/api/projects/${project}`) && item.request().method() === "PUT",
  );
  await student.getByRole("button", { name: "Rename scene", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  await student
    .locator('.server-session [role="status"]')
    .filter({ hasText: "Saved to server" })
    .waitFor();
  const outsiderContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await login(outsiderContext, process.env.SPATIA_TEST_OUTSIDER);
  assert.equal(
    (await outsiderContext.request.get(`${origin}/api/projects/${project}`)).status(),
    404,
  );
  const freshContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const fresh = await login(freshContext, process.env.SPATIA_TEST_STUDENT);
  await fresh.goto(`${origin}/?projectId=${project}`);
  await fresh.getByRole("button", { name: "Scenes", exact: true }).click();
  assert.equal(
    await fresh.getByLabel("Scene name", { exact: true }).inputValue(),
    "Saved by student",
  );
  await Promise.all([
    teacher.close(),
    studentContext.close(),
    outsiderContext.close(),
    freshContext.close(),
  ]);
  console.log("Live assignment, student open/save, fresh reopen and outsider denial passed");
} finally {
  await browser?.close();
  await server.close();
}
