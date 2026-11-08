import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

for (const name of [
  "SPATIA_API_ORIGIN",
  "SPATIA_DEV_TLS_CERT",
  "SPATIA_DEV_TLS_KEY",
  "SPATIA_API_CA",
  "SPATIA_TEST_EDUCATOR",
  "SPATIA_TEST_STUDENT",
  "SPATIA_TEST_OUTSIDER",
  "SPATIA_TEST_CLASS",
])
  assert.ok(process.env[name], `Missing ${name}`);

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

async function sceneReady(page) {
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 30000 });
  const canvas = page.locator(".viewport-stage canvas");
  await canvas.waitFor();
  assert.ok(await canvas.evaluate((node) => node.width > 0 && node.height > 0));
}

try {
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  const teacher = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
  });
  const page = await login(teacher, process.env.SPATIA_TEST_EDUCATOR);
  const catalogue = await teacher.request.get(`${origin}/api/v1/assets`);
  assert.equal(catalogue.status(), 200);
  assert.deepEqual(await catalogue.json(), [], "The fixture has no approved assets");
  await page.getByRole("link", { name: /New Project/ }).click();
  await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
  await page.getByLabel("Project title").fill("Empty source project");
  await page.getByLabel("Project description").fill("Blank source project");
  await page.getByLabel("Project instructions").fill("Explore the empty scene.");
  await page.getByLabel(/^Due date/).fill("2035-12-01T15:30");
  await page.getByLabel(/^Class/).selectOption(process.env.SPATIA_TEST_CLASS);
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) }).check();
  const creating = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/projects" &&
      response.request().method() === "POST",
  );
  const initialAssignment = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/assignments") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const created = await creating;
  assert.equal(created.status(), 201);
  assert.deepEqual(created.request().postDataJSON(), { title: "Empty source project" });
  const receipt = await created.json();
  const sourceId = receipt.projectId;
  assert.ok(sourceId);
  const initialAssigned = await initialAssignment;
  assert.equal(initialAssigned.status(), 201);
  assert.equal(initialAssigned.request().postDataJSON().sourceProjectId, sourceId);
  assert.equal((await initialAssigned.json()).projects.length, 1);
  await page.waitForURL(/\/home\?/);
  await page.goto(`${origin}/?projectId=${sourceId}`);
  await page.waitForURL(`**/?projectId=${sourceId}`);
  await sceneReady(page);
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByLabel("Scene name", { exact: true }).fill("Edited empty scene");
  const saving = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/projects/${sourceId}` &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Rename scene", exact: true }).click();
  assert.equal((await saving).status(), 200);
  await page
    .locator('.server-session [role="status"]')
    .filter({ hasText: "Saved to server" })
    .waitFor();
  const sourceResponse = await teacher.request.get(`${origin}/api/v1/projects/${sourceId}`);
  assert.equal(sourceResponse.status(), 200);
  const source = await sourceResponse.json();
  assert.equal(source.document.scenes[0].name, "Edited empty scene");
  assert.equal(source.document.scenes[0].environmentAssetId, null);
  assert.deepEqual(source.document.scenes[0].objects, []);
  await page.getByRole("button", { name: "Leave editor" }).click();
  await page.getByRole("button", { name: "Exit" }).click();
  await page.waitForURL(`${origin}/home`);
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  assert.equal(await page.getByLabel("Source project").count(), 0);
  await page.getByLabel("Project title").fill("Empty class assignment");
  await page.getByLabel("Project description").fill("Independent exhibit");
  await page.getByLabel("Project instructions").fill("Explain each exhibit.");
  await page.getByLabel(/^Due date/).fill("2035-12-01T15:30");
  await page.getByLabel(/^Class/).selectOption(process.env.SPATIA_TEST_CLASS);
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) }).check();
  const assigning = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/assignments") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project" }).click();
  const assigned = await assigning;
  assert.equal(assigned.status(), 201);
  const assignment = await assigned.json();
  assert.equal(assignment.projects.length, 1);
  const assignedId = assignment.projects[0].projectId;
  assert.ok(assignedId);

  const studentContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
  });
  const student = await login(studentContext, process.env.SPATIA_TEST_STUDENT);
  await student.getByRole("button", { name: "Classes", exact: true }).click();
  await student.getByRole("button", { name: "Empty class assignment", exact: true }).click();
  await student.getByText("Explain each exhibit.", { exact: true }).waitFor();
  await student.getByRole("button", { name: "Open your project", exact: true }).click();
  await student.waitForURL(`**/?projectId=${assignedId}`);
  await sceneReady(student);
  await student.getByRole("button", { name: "Scenes", exact: true }).click();
  assert.equal(await student.getByLabel("Scene name", { exact: true }).inputValue(), "Scene");
  const outsider = await browser.newContext({ ignoreHTTPSErrors: true });
  await login(outsider, process.env.SPATIA_TEST_OUTSIDER);
  assert.equal(
    (await outsider.request.get(`${origin}/api/v1/projects/${assignedId}`)).status(),
    404,
  );
  await Promise.all([teacher.close(), studentContext.close(), outsider.close()]);
  console.log(
    "Real empty project creation, save, assignment, student open and outsider denial passed",
  );
} finally {
  await browser?.close();
  await server.close();
}
