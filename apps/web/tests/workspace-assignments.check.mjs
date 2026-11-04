import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const teacher = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const source = "aefea67c-caca-4300-923c-937f1c785578";
const alice = "bbf2b1d0-b388-4df8-a995-930148dcdd19";
const bob = "cc0ec5ca-2991-403f-8527-d566028345ab";
let account = {
  userId: teacher,
  displayName: "Teacher",
  orgId: org,
  role: "Educator",
  mustChangePassword: false,
};
const classes = [{ id: classId, name: "History", organizationId: org }];
let students = [
  { userId: alice, userName: "Alice", enrolled: true },
  { userId: bob, userName: "Bob", enrolled: false },
];
let assignment = null;
const attempts = [];
let lostResponse = true;
let failRoster = false;
let releaseCreation;
let heldCreation;
const snapshots = "../../.artifacts/home-check";
await mkdir(snapshots, { recursive: true });
const errors = [];
async function api(route) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  if (path === "/api/auth/session") return route.fulfill({ json: account });
  if (path === "/api/auth/csrf") return route.fulfill({ json: { requestToken: "test-token" } });
  if (method !== "GET") assert.equal(request.headers()["x-csrf-token"], "test-token");
  if (path === "/api/projects")
    return route.fulfill({
      json: {
        items: [
          {
            projectId: source,
            title: "Museum source",
            revision: 3,
            updatedAt: "2026-10-30T01:00:00Z",
            archived: false,
            permissions: {
              canEdit: true,
              canManage: account.role !== "Creator",
              canPublish: false,
            },
          },
        ],
        nextCursor: null,
      },
    });
  if (path === "/api/classes" && method === "POST") {
    const body = request.postDataJSON();
    assert.deepEqual(body, { name: "Geography" });
    const row = {
      id: "ddca2d1b-b065-41f5-9cae-961d8d1855af",
      name: body.name,
      organizationId: org,
    };
    classes.push(row);
    return route.fulfill({ status: 201, json: row });
  }
  if (path === "/api/classes") return route.fulfill({ json: { items: classes, nextCursor: null } });
  if (/\/members\//.test(path)) {
    const id = path.split("/").at(-1);
    const student = students.find((row) => row.userId === id);
    assert.ok(student);
    student.enrolled = method === "PUT";
    return route.fulfill({ status: 204 });
  }
  if (/\/(roster|eligible-students)$/.test(path)) {
    if (account.role === "Creator" || failRoster) return route.fulfill({ status: 404 });
    return route.fulfill({
      json: {
        items: path.endsWith("eligible-students")
          ? students
          : students
              .filter((student) => student.enrolled)
              .map((student) => ({
                userId: student.userId,
                userName: student.userName,
                roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
                accountActive: true,
              })),
        nextCursor: null,
      },
    });
  }
  if (path === `/api/classes/${classId}/assignments` && method === "POST") {
    const body = request.postDataJSON();
    attempts.push(body);
    assert.equal(body.sourceProjectId, source);
    assert.equal(body.sourceRevision, 3);
    assert.deepEqual(body.studentIds.sort(), [alice, bob].sort());
    assert.equal(body.dueAtUnixSeconds, Date.parse("2026-11-05T10:00:00Z") / 1000);
    if (assignment) assert.deepEqual(body, attempts[0]);
    else
      assignment = {
        ...body,
        assignmentId: body.requestId,
        projects: [
          { studentId: alice, projectId: alice },
          { studentId: bob, projectId: bob },
        ],
      };
    if (heldCreation) await heldCreation;
    if (lostResponse) {
      lostResponse = false;
      return route.abort();
    }
    return route.fulfill({
      json: { assignmentId: assignment.assignmentId, projects: assignment.projects },
    });
  }
  if (path.includes("/assignments")) {
    const visible = assignment
      ? {
          ...assignment,
          projects:
            account.role === "Creator"
              ? assignment.projects.filter((row) => row.studentId === account.userId)
              : assignment.projects,
        }
      : null;
    return path.endsWith("/assignments")
      ? route.fulfill({ json: { items: visible ? [visible] : [], nextCursor: null } })
      : visible
        ? route.fulfill({ json: visible })
        : route.fulfill({ status: 404 });
  }
  return route.fulfill({ status: 404 });
}
try {
  const context = await browser.newContext({
    timezoneId: "Asia/Singapore",
    locale: "en-US",
    viewport: { width: 1440, height: 1100 },
  });
  await context.route("**/api/**", api);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/home");
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "Enrol Bob", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Remove Bob", exact: true }).waitFor();
  await page.getByRole("button", { name: "Remove Bob", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Enrol Bob", exact: true }).waitFor();
  await page.getByRole("button", { name: "Enrol Bob", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Remove Bob", exact: true }).waitFor();
  failRoster = true;
  await page.getByRole("button", { name: "Refresh classes" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /roster is unavailable/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Remove Bob", exact: true }).count(), 0);
  failRoster = false;
  await page.getByRole("button", { name: "Refresh classes" }).click();
  await page.getByRole("button", { name: "Remove Bob", exact: true }).waitFor();
  await page.getByRole("button", { name: "New class", exact: true }).click();
  await page.getByLabel("Class name", { exact: true }).fill("Geography");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Class change confirmed.", { exact: true }).waitFor();
  assert.equal(classes.length, 2);
  await page.getByRole("combobox", { name: "Class", exact: true }).selectOption(classId);
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  await page.getByRole("combobox", { name: "Source project", exact: true }).selectOption(source);
  await page
    .getByRole("textbox", { name: "Project title", exact: true })
    .fill("Silk Road assignment");
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("dialog", { name: "Leave this assignment?" }).waitFor();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Project title", exact: true }).inputValue(),
    "Silk Road assignment",
  );
  await page.getByRole("link", { name: "Spatia home" }).click();
  await page.getByRole("dialog", { name: "Leave this assignment?" }).waitFor();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Project title", exact: true }).inputValue(),
    "Silk Road assignment",
  );
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("combobox", { name: "Class", exact: true }).selectOption(classId);
  await page.getByLabel("Due date and time").fill("2026-11-05T18:00");
  await page.getByLabel("Project description").fill("Research trade across the Silk Road.");
  await page.getByLabel("Project instructions").fill("Build an exhibit and explain each object.");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `assignment overflows at ${width}`,
    );
    await page.screenshot({ path: `${snapshots}/assignment-${width}.png`, fullPage: true });
  }
  heldCreation = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  await page.evaluate(() => {
    window.pendingNavigationGuard = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('form[aria-busy="true"]')) return;
        observer.disconnect();
        const classes = [...document.querySelectorAll('nav[aria-label="Workspace"] button')].find(
          (button) => button.textContent.trim() === "Classes",
        );
        document.querySelector('a[aria-label="Spatia home"]').click();
        resolve(classes.disabled);
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    });
  });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  assert.equal(await page.evaluate(() => window.pendingNavigationGuard), true);
  await page.getByText("Creating project… Keep this page open.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Classes", exact: true }).isDisabled(), true);
  await page.getByRole("link", { name: "Spatia home" }).click();
  await page.getByText("Creating project… Keep this page open.", { exact: true }).waitFor();
  releaseCreation();
  heldCreation = null;
  await page.getByRole("button", { name: "Retry same assignment", exact: true }).waitFor();
  assert.equal(attempts.length, 1);
  await page.reload();
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  await page.getByRole("button", { name: "Retry same assignment", exact: true }).click();
  await page.getByRole("heading", { name: "Silk Road assignment", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open project for Alice", exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(
    await page.evaluate((id) => localStorage.getItem(`spatia.assignment.pending:${id}`), teacher),
    null,
  );
  account = { ...account, userId: alice, displayName: "Alice", role: "Creator" };
  const localContext = await browser.newContext({
    timezoneId: "America/New_York",
    locale: "en-US",
    viewport: { width: 390, height: 900 },
  });
  await localContext.route("**/api/**", api);
  const local = await localContext.newPage();
  local.on("pageerror", (error) => errors.push(error.message));
  await local.goto(origin + "/home");
  await local.getByRole("button", { name: "Classes", exact: true }).click();
  await local.getByRole("combobox", { name: "Class", exact: true }).selectOption(classId);
  await local.getByRole("button", { name: "Silk Road assignment", exact: true }).click();
  await local.getByText("Build an exhibit and explain each object.", { exact: true }).waitFor();
  await local.getByText(/Nov 5, 2026.*5:00 AM/).waitFor();
  assert.equal(
    await local.getByRole("button", { name: "Open your project", exact: true }).count(),
    1,
  );
  assert.equal(
    await local.getByRole("button", { name: "Open your project", exact: true }).isDisabled(),
    false,
  );
  assert.equal(await local.getByRole("button", { name: "New assignment", exact: true }).count(), 0);
  assert.equal(await local.getByRole("region", { name: "Class roster", exact: true }).count(), 0);
  assert.ok(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await local.screenshot({ path: `${snapshots}/student-assignment-390.png`, fullPage: true });
  await local.route(`**/?projectId=${alice}`, (route) => route.fulfill({ body: "editor" }));
  await local.getByRole("button", { name: "Open your project", exact: true }).click();
  await local.waitForURL(`**/?projectId=${alice}`);
  assert.deepEqual(errors, []);
  console.log(
    "Workspace class creation, roster changes, denied states, guarded navigation, exact assignment retries, student views and device-local deadlines passed.",
  );
} finally {
  await browser.close();
}
