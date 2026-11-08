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
  "SPATIA_TEST_ENVIRONMENT",
  "SPATIA_TEST_RETAINED_PROJECT",
  "SPATIA_TEST_RETAINED_ASSET",
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
  const catalogue = await teacher.request.get(`${origin}/api/v1/assets`);
  assert.equal(
    catalogue.status(),
    200,
    "Approved space catalogue must be available to the educator",
  );
  const spaces = await catalogue.json();
  assert.ok(
    spaces.some(
      (space) => space.id === process.env.SPATIA_TEST_ENVIRONMENT && space.kind === "environment",
    ),
    "The seeded approved space must be returned by the actual API",
  );
  await page.getByRole("link", { name: /New Project/ }).click();
  await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
  await page.getByLabel("Project title").fill("Live blank project");
  await page.getByLabel("Project description").fill("Blank source project");
  await page.getByLabel("Project instructions").fill("Explore the room.");
  await page.getByLabel(/^Due date/).fill("2035-12-01T15:30");
  await page.getByLabel(/^Class/).selectOption(process.env.SPATIA_TEST_CLASS);
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) }).check();
  const createdResponse = page.waitForResponse(
    (item) => item.url().endsWith("/api/v1/projects") && item.request().method() === "POST",
  );
  const initialAssignment = page.waitForResponse(
    (item) => item.url().endsWith("/assignments") && item.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  assert.deepEqual(created.request().postDataJSON(), { title: "Live blank project" });
  const blank = await created.json();
  const initialReceipt = await initialAssignment;
  assert.equal(initialReceipt.status(), 201);
  assert.equal(initialReceipt.request().postDataJSON().sourceProjectId, blank.projectId);
  assert.equal((await initialReceipt.json()).projects.length, 1);
  await page.waitForURL(/\/home\?/);
  await page.goto(`${origin}/?projectId=${blank.projectId}`);
  await page.waitForURL(`**/?projectId=${blank.projectId}`);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 30000 });
  const environmentResponse = page.waitForResponse(
    (item) =>
      new URL(item.url()).pathname.endsWith(
        `/assets/${process.env.SPATIA_TEST_ENVIRONMENT}/bytes`,
      ) && item.request().method() === "GET",
    { timeout: 30000 },
  );
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  await page.getByRole("button", { name: "Approved browser room", exact: true }).click();
  const environment = await environmentResponse;
  assert.equal(environment.status(), 200, "The editor loads the approved environment bytes");
  assert.ok((await environment.body()).length > 0, "The environment response contains GLB bytes");
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.viewport [role="status"]')].some(
      (status) => status.textContent === "Scene ready",
    ),
  );
  try {
    await page.getByRole("button", { name: "Leave editor" }).click();
  } catch (error) {
    const status = await page.locator('[role="alert"], [role="status"]').allTextContents();
    throw new Error(`Created editor did not open. Visible status: ${status.join(" | ")}`, {
      cause: error,
    });
  }
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(`${origin}/home`);
  const retainedId = process.env.SPATIA_TEST_RETAINED_PROJECT;
  const retainedAsset = process.env.SPATIA_TEST_RETAINED_ASSET;
  const retainedBytes = page.waitForResponse(
    (item) =>
      new URL(item.url()).pathname ===
      `/api/v1/projects/${retainedId}/assets/${retainedAsset}/bytes`,
    { timeout: 30000 },
  );
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Retained room project", exact: true }) })
    .getByRole("button", { name: "View Details" })
    .click();
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await page.waitForURL(`**/?projectId=${retainedId}`);
  const retainedResponse = await retainedBytes;
  assert.equal(retainedResponse.status(), 200, "Saved retired room bytes remain available");
  assert.ok((await retainedResponse.body()).length > 0);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  assert.equal(
    await page
      .getByRole("group", { name: "Rooms options" })
      .getByRole("button", { name: "Retired browser room" })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  assert.match(
    await page.getByRole("combobox", { name: "Environment", exact: true }).textContent(),
    /Retired browser room/,
  );
  await page.getByLabel("Scene name", { exact: true }).fill("Retained room saved");
  assert.equal(
    await page.getByRole("button", { name: "Add scene", exact: true }).isDisabled(),
    true,
    "A retired room cannot be selected for a new scene",
  );
  await page.getByRole("combobox", { name: "New scene environment" }).click();
  await page.getByRole("option", { name: "Approved browser room" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Add scene", exact: true }).isEnabled(),
    true,
  );
  const retainedSave = page.waitForResponse(
    (item) =>
      new URL(item.url()).pathname.toLowerCase() ===
        `/api/v1/projects/${retainedId}`.toLowerCase() && item.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Rename scene", exact: true }).click();
  let savedRetained;
  try {
    savedRetained = await retainedSave;
  } catch (error) {
    const status = await page.locator('[role="alert"], [role="status"]').allTextContents();
    throw new Error(
      `Retained room save did not reach the API. Visible status: ${status.join(" | ")}`,
      { cause: error },
    );
  }
  assert.equal(savedRetained.status(), 200, "A project retaining the retired room can be saved");
  await page.getByRole("button", { name: "Leave editor" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(`${origin}/home`);
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  assert.equal(await page.getByLabel("Source project").count(), 0);
  await page.getByLabel("Project title").fill("Live class assignment");
  await page.getByLabel("Project description").fill("Independent exhibit");
  await page.getByLabel("Project instructions").fill("Explain each exhibit.");
  await page.getByLabel(/^Due date/).fill("2026-12-01T15:30");
  await page.getByLabel(/^Class/).selectOption(process.env.SPATIA_TEST_CLASS);
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) }).check();
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_OUTSIDER) }).check();
  const response = page.waitForResponse(
    (item) => item.url().endsWith("/assignments") && item.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project" }).click();
  const receiptResponse = await response;
  assert.equal(receiptResponse.status(), 201);
  const receipt = await receiptResponse.json();
  assert.equal(receipt.projects.length, 2);
  const rosterResponse = await teacher.request.get(
    `${origin}/api/v1/classes/${process.env.SPATIA_TEST_CLASS}/eligible-students?limit=20`,
  );
  const roster = (await rosterResponse.json()).items;
  const studentId = roster.find((row) => row.userName === process.env.SPATIA_TEST_STUDENT).userId;
  const outsiderId = roster.find((row) => row.userName === process.env.SPATIA_TEST_OUTSIDER).userId;
  const project = receipt.projects.find((row) => row.studentId === studentId).projectId;
  const removedProject = receipt.projects.find((row) => row.studentId === outsiderId).projectId;
  await page.getByRole("heading", { name: "Live class assignment" }).waitFor();
  await page.getByRole("button", { name: "Edit project details" }).click();
  await page.getByLabel("Project description").fill("Updated independent exhibit");
  await page
    .getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_OUTSIDER) })
    .uncheck();
  const editing = page.waitForResponse(
    (item) =>
      item.url().endsWith("/assignments/" + receipt.assignmentId) &&
      item.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  const edited = await editing;
  assert.equal(edited.status(), 200);
  const editBody = edited.request().postDataJSON();
  assert.equal(editBody.expectedRevision, 0);
  assert.ok(editBody.mutationId);
  assert.deepEqual(editBody.studentIds, [studentId]);
  await page.getByText("Updated independent exhibit", { exact: true }).waitFor();
  const editedDetail = await teacher.request.get(
    `${origin}/api/v1/classes/${process.env.SPATIA_TEST_CLASS}/assignments/${receipt.assignmentId}`,
  );
  assert.equal(editedDetail.status(), 200);
  assert.equal((await editedDetail.json()).projects.length, 1);
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
    (item) =>
      item.url().endsWith(`/api/v1/projects/${project}`) && item.request().method() === "PUT",
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
    (await outsiderContext.request.get(`${origin}/api/v1/projects/${retainedId}/assets`)).status(),
    404,
  );
  assert.equal(
    (await outsiderContext.request.get(`${origin}/api/v1/projects/${project}`)).status(),
    404,
  );
  assert.equal(
    (await outsiderContext.request.get(`${origin}/api/v1/projects/${removedProject}`)).status(),
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
