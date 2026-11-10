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
  await page.waitForURL(`${origin}/home`);
  return page;
}
try {
  browser = await launchBrowser({
    target: origin,
    args: ["--enable-unsafe-swiftshader"],
  });
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
  await page.getByRole("textbox", { name: /^Project description/ }).fill("Blank source project");
  await page.getByRole("textbox", { name: /^Project instructions/ }).fill("Explore the room.");
  await page.getByLabel(/^Due date/).fill("2035-12-01");
  await chooseProjectClass(page);
  await page
    .getByRole("checkbox", {
      name: new RegExp(process.env.SPATIA_TEST_STUDENT),
    })
    .check();
  const createdResponse = page.waitForResponse(
    (item) => item.url().endsWith("/api/v1/projects") && item.request().method() === "POST",
  );
  const initialAssignment = page.waitForResponse(
    (item) => item.url().endsWith("/assignments") && item.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  assert.deepEqual(created.request().postDataJSON(), {
    title: "Live blank project",
  });
  const blank = await created.json();
  const initialReceipt = await initialAssignment;
  assert.equal(initialReceipt.status(), 201);
  assert.equal(initialReceipt.request().postDataJSON().sourceProjectId, blank.projectId);
  assert.equal((await initialReceipt.json()).projects.length, 1);
  await page.waitForURL(`${origin}/home`);
  const retainedId = process.env.SPATIA_TEST_RETAINED_PROJECT;
  const retainedAsset = process.env.SPATIA_TEST_RETAINED_ASSET;
  const retainedResponse = await teacher.request.get(
    `${origin}/api/v1/projects/${retainedId}/assets/${retainedAsset}/bytes`,
  );
  assert.equal(retainedResponse.status(), 200, "Existing projects retain retired room bytes");
  assert.ok((await retainedResponse.body()).length > 0);
  await page.goto(`${origin}/classes`);
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  assert.equal(await page.getByLabel("Source project").count(), 0);
  await page.getByLabel("Project title").fill("Live class assignment");
  await page.getByRole("textbox", { name: /^Project description/ }).fill("Independent exhibit");
  await page.getByRole("textbox", { name: /^Project instructions/ }).fill("Explain each exhibit.");
  await page.getByLabel(/^Due date/).fill("2026-12-01");
  await chooseProjectClass(page);
  await page
    .getByRole("checkbox", {
      name: new RegExp(process.env.SPATIA_TEST_STUDENT),
    })
    .check();
  await page
    .getByRole("checkbox", {
      name: new RegExp(process.env.SPATIA_TEST_OUTSIDER),
    })
    .check();
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
  await page.goto(
    `${origin}/home?classId=${process.env.SPATIA_TEST_CLASS}&assignmentId=${receipt.assignmentId}`,
  );
  await page.getByRole("heading", { name: "Live class assignment" }).waitFor();
  await page.getByRole("button", { name: "Edit Project Description" }).click();
  await page
    .getByRole("textbox", { name: /^Project description/ })
    .fill("Updated independent exhibit");
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
  assert.deepEqual(new Set(editBody.studentIds), new Set([studentId, outsiderId]));
  const token = await (await teacher.request.get(`${origin}/api/v1/auth/csrf`)).json();
  const removal = await teacher.request.patch(
    `${origin}/api/v1/classes/${process.env.SPATIA_TEST_CLASS}/assignments/${receipt.assignmentId}`,
    {
      headers: { "X-CSRF-TOKEN": token.requestToken },
      data: {
        ...editBody,
        expectedRevision: 1,
        mutationId: crypto.randomUUID(),
        studentIds: [studentId],
      },
    },
  );
  assert.equal(removal.status(), 200);
  await page.getByText("Updated independent exhibit", { exact: true }).waitFor();
  const editedDetail = await teacher.request.get(
    `${origin}/api/v1/classes/${process.env.SPATIA_TEST_CLASS}/assignments/${receipt.assignmentId}`,
  );
  assert.equal(editedDetail.status(), 200);
  assert.equal((await editedDetail.json()).projects.length, 1);
  await page.reload();
  await page.goto(`${origin}/classes`);
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
  await student.goto(`${origin}/classes`);
  await student.getByRole("button", { name: "Live class assignment", exact: true }).click();
  await student.getByText("Explain each exhibit.", { exact: true }).waitFor();
  await student.getByRole("button", { name: "Open your project", exact: true }).click();
  await student.waitForURL(`**/?projectId=${project}`);
  await student.getByRole("button", { name: "Rooms", exact: true }).click();
  await student.getByRole("button", { name: "Approved browser room", exact: true }).click();
  await student.locator('.save-state[data-state="saved"]').waitFor();
  await student.getByRole("button", { name: "Scenes", exact: true }).click();
  await student.getByLabel("Scene name", { exact: true }).fill("Saved by student");
  const savedResponse = student.waitForResponse(
    (item) =>
      item.url().endsWith(`/api/v1/projects/${project}`) && item.request().method() === "PUT",
  );
  await student.getByRole("button", { name: "Rename scene", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  await student.locator('.save-state[data-state="saved"]').waitFor();
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
  // Follow the same assigned project across both roles and an anonymous visitor.
  await fresh.getByRole("button", { name: "Request approval", exact: true }).click();
  const approval = fresh.getByRole("dialog", { name: "Finish your work first", exact: true });
  await approval.getByRole("button", { name: "Mark as Completed", exact: true }).click();
  await fresh
    .getByRole("dialog", { name: "Your teacher is reviewing your work", exact: true })
    .getByRole("button", { name: "Back to Project", exact: true })
    .click();
  await approval.waitFor({ state: "detached" });
  await page.goto(
    `${origin}/home?${new URLSearchParams({
      classId: process.env.SPATIA_TEST_CLASS,
      assignmentId: receipt.assignmentId,
      studentId,
      reviewProjectId: project,
    })}`,
  );
  const review = page.getByRole("dialog", { name: "Review submission", exact: true });
  await review.getByLabel("Your review").fill("The saved room is ready to share.");
  await review.getByRole("button", { name: "Approve to publish", exact: true }).click();
  await review
    .getByText("Approval saved. The student can now publish the approved revision.", {
      exact: true,
    })
    .waitFor();
  await fresh.goto(`${origin}/home`);
  await fresh.locator(`#student-project-${project}`).click();
  const details = fresh.getByRole("dialog", { name: "Project details", exact: true });
  await details.getByText("The saved room is ready to share.", { exact: true }).waitFor();
  await details.getByRole("button", { name: "Publish", exact: true }).click();
  const publishing = fresh.getByRole("dialog", {
    name: "Ready to publish your project?",
    exact: true,
  });
  await fresh.waitForFunction(() => {
    const button = [...document.querySelectorAll(".creator-publish-status-dialog button")].find(
      (button) => button.textContent === "Publish Project",
    );
    return button && !button.disabled;
  });
  assert.equal(
    await publishing.getByRole("button", { name: "Publish Project", exact: true }).isEnabled(),
    true,
    "The approved saved project is ready to publish",
  );
  const publicationResponse = fresh.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/projects/${project}/publications`) &&
      response.request().method() === "POST",
  );
  await publishing.getByRole("button", { name: "Publish Project", exact: true }).click();
  const committed = await publicationResponse;
  assert.equal(committed.status(), 201);
  const publication = await committed.json();
  await fresh.waitForURL(`${origin}/home?tab=published`);
  const visitorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const visitor = await visitorContext.newPage();
  visitor.setDefaultTimeout(20000);
  const shared = new URL(publication.visitorUrl);
  await visitor.goto(origin + shared.pathname + shared.search + shared.hash);
  await visitor.getByRole("button", { name: "Start exhibition", exact: true }).click();
  await visitor.locator("canvas").waitFor();
  assert.equal(
    (
      await visitorContext.request.get(`${origin}/api/v1/publications/${publication.publicationId}`)
    ).status(),
    200,
  );
  await visitorContext.close();
  console.log(
    "Full role handoff passed: create, assign, edit, reopen, submit, feedback, approve, publish and anonymous shared link; each action clicked once.",
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

// Resolve the real class label for the custom field without assuming a seeded display name
async function chooseProjectClass(page) {
  const control = page.getByRole("combobox", { name: /^Class/ });
  if (await control.evaluate((element) => element.tagName === "SELECT")) {
    await control.selectOption(process.env.SPATIA_TEST_CLASS);
    return;
  }
  const response = await page.request.get(`${origin}/api/v1/classes?limit=20`);
  assert.equal(response.status(), 200);
  const classes = await response.json();
  const selected = classes.items.find((item) => item.id === process.env.SPATIA_TEST_CLASS);
  assert.ok(selected, "The seeded class must be available");
  await control.click();
  await page.getByRole("option", { name: selected.name, exact: true }).click();
}
