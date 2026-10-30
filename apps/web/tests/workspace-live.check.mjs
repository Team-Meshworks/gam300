import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// Run only against the disposable HTTPS fixture; no production credentials or API mocks.
const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const data = JSON.parse(process.argv[3]);
const origin = target.origin;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const snapshots = "../../.artifacts/home-check";
await mkdir(snapshots, { recursive: true });
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
    locale: "en-US",
    viewport: { width: 1440, height: 1100 },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function login(name) {
    await page.goto(origin + "/login");
    await page.getByLabel("Username", { exact: true }).fill(name);
    await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByRole("link", { name: "Go to projects" }).click();
  }
  await login(data.teacher);
  await page.getByRole("heading", { name: "Live museum source", exact: true }).waitFor();
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await page.getByLabel("Copy title").fill("Live copied source");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("heading", { name: "Live copied source", exact: true }).waitFor();
  const original = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Live museum source", exact: true }) });
  await original.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Project archived.", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Archived", exact: true }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Project reopened.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: `Enrol ${data.bob}`, exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: `Remove ${data.bob}`, exact: true }).waitFor();
  await page.getByRole("button", { name: "New class", exact: true }).click();
  await page.getByLabel("Class name", { exact: true }).fill("Geography");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Class change confirmed.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Source project", exact: true })
    .selectOption(data.source);
  await page
    .getByRole("textbox", { name: "Project title", exact: true })
    .fill("Live class assignment");
  await page.getByRole("combobox", { name: "Class", exact: true }).selectOption(data.classId);
  await page.getByLabel("Due date and time").fill("2026-11-05T18:00");
  await page.getByLabel("Project description").fill("Independent student museum projects.");
  await page.getByLabel("Project instructions").fill("Explain the history of each exhibit.");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  const attempts = [];
  let assignmentId;
  await context.route(`**/api/classes/${data.classId}/assignments`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    attempts.push(body);
    assert.equal(body.sourceRevision, 2);
    assert.equal(body.dueAtUnixSeconds, Date.parse("2026-11-05T10:00:00Z") / 1000);
    const response = await route.fetch();
    assert.equal(response.status(), attempts.length === 1 ? 201 : 200);
    assignmentId = body.requestId;
    if (attempts.length === 1) return route.abort();
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("button", { name: "Retry same assignment", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  await page.getByRole("button", { name: "Retry same assignment", exact: true }).click();
  await page.getByRole("heading", { name: "Live class assignment", exact: true }).waitFor();
  await page.getByRole("button", { name: `Open project for ${data.alice}`, exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  const teacherDetailsResponse = await context.request.get(
    `${origin}/api/classes/${data.classId}/assignments/${assignmentId}`,
  );
  assert.equal(teacherDetailsResponse.status(), 200);
  const teacherDetails = await teacherDetailsResponse.json();
  assert.equal(teacherDetails.projects.length, 2);
  assert.notEqual(teacherDetails.projects[0].projectId, teacherDetails.projects[1].projectId);
  await page.screenshot({ path: `${snapshots}/live-teacher-assignment.png`, fullPage: true });
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.getByRole("heading", { name: "Log in to your workspace" }).waitFor();
  await login(data.alice);
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "Live class assignment", exact: true }).click();
  await page.getByText("Explain the history of each exhibit.", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Open your project", exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole("region", { name: "Class roster", exact: true }).count(), 0);
  const studentDetails = await (
    await context.request.get(`${origin}/api/classes/${data.classId}/assignments/${assignmentId}`)
  ).json();
  assert.equal(studentDetails.projects.length, 1);
  assert.equal(studentDetails.projects[0].studentId, data.aliceId);
  const bobProject = teacherDetails.projects.find((row) => row.studentId === data.bobId).projectId;
  assert.equal((await context.request.get(`${origin}/api/projects/${bobProject}`)).status(), 404);
  assert.equal(
    (await context.request.get(`${origin}/api/classes/${data.classId}/roster`)).status(),
    404,
  );
  await page.setViewportSize({ width: 390, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(
    await page.getByRole("button", { name: "Log Out", exact: true }).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth;
    }),
  );
  await page.screenshot({ path: `${snapshots}/live-student-assignment.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Live API/browser flow passed: login, duplicate/archive/reopen, class creation, enrolment, committed-response loss/replay, student-only assignment data and cross-student denial.",
  );
} finally {
  await browser.close();
}
