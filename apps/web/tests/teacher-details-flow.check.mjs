import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacher = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const assignmentId = "de000000-0000-4000-8000-000000000001";
const sourceId = "de000000-0000-4000-8000-000000000002";
const studentId = "de000000-0000-4000-8000-000000000003";
const studentProjectId = "de000000-0000-4000-8000-000000000004";
const otherId = "de000000-0000-4000-8000-000000000005";
const server = await createServer({
  cacheDir: "test-results/vite-teacher-details",
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  let enrolled = false;
  const enrolId = "de000000-0000-4000-8000-000000000006";
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (
      path === `/api/v1/classes/${classId}/members/${enrolId}` &&
      route.request().method() === "PUT"
    ) {
      assert.equal(route.request().headers()["x-csrf-token"], "test-token");
      enrolled = true;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/eligible-students"))
      return route.fulfill({
        json: {
          items: [
            { userId: studentId, userName: "Alice", enrolled: true },
            { userId: enrolId, userName: "Bob", enrolled },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: teacher,
          displayName: "Ms Chew",
          orgId: org,
          orgName: "School",
          role: "Educator",
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/classes")
      return route.fulfill({
        json: {
          items: [{ id: classId, name: "History", organizationId: org }],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({
        json: {
          items: [
            sourceId,
            otherId,
            "de000000-0000-4000-8000-000000000021",
            "de000000-0000-4000-8000-000000000022",
          ].map((projectId) => ({
            projectId,
            title:
              projectId === sourceId
                ? "Museum"
                : projectId === otherId
                  ? "Standalone"
                  : "Retained class copy",
            isClassProject: projectId !== otherId,
            revision: 1,
            updatedAt: "2026-11-01T00:00:00Z",
            archived: false,
            permissions: { canEdit: true, canManage: true, canPublish: false },
          })),
          nextCursor: null,
        },
      });
    if (path.endsWith("/roster"))
      return route.fulfill({
        json: {
          items: [
            {
              userId: studentId,
              userName: "Alice",
              roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
              accountActive: true,
            },
            ...(enrolled
              ? [
                  {
                    userId: enrolId,
                    userName: "Bob",
                    roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
                    accountActive: true,
                  },
                ]
              : []),
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/assignments"))
      return route.fulfill({
        json: {
          items: [
            {
              assignmentId,
              sourceProjectId: sourceId,
              title: "Museum",
              organizationName: "School",
              creatorUserName: "mschew",
              description: "Build a museum",
              instructions: "Add exhibits",
              dueAtUnixSeconds: 1796200000,
              projects: [
                {
                  projectId: studentProjectId,
                  studentId,
                  studentName: "Alice",
                  approvalStatus: "approved",
                  published: true,
                  isPublic: true,
                },
                {
                  projectId: "de000000-0000-4000-8000-000000000006",
                  studentId: "de000000-0000-4000-8000-000000000007",
                  studentName: "Bob",
                  approvalStatus: "awaiting-approval",
                  published: false,
                  isPublic: false,
                },
                {
                  projectId: "de000000-0000-4000-8000-000000000008",
                  studentId: "de000000-0000-4000-8000-000000000009",
                  studentName: "Cara",
                  approvalStatus: "not-submitted",
                  published: false,
                  isPublic: false,
                },
                {
                  projectId: "de000000-0000-4000-8000-000000000010",
                  studentId: "de000000-0000-4000-8000-000000000011",
                  studentName: "Dee",
                },
              ],
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/home");
  const assignmentCard = page.locator("article").filter({
    has: page.locator(`[id="teacher-project-${classId}:${assignmentId}"]`),
  });
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  assert.equal(await page.getByText("Build a museum", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Add exhibits", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Alice", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "View Progress" }).count(), 4);
  const student = (name) =>
    page.locator(".sp-teacher-student").filter({ has: page.getByText(name, { exact: true }) });
  assert.equal(
    await student("Alice")
      .locator(".sp-teacher-student-status")
      .getByText("Approved", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Alice")
      .locator(".sp-teacher-student-status")
      .getByText("Public", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Bob")
      .locator(".sp-teacher-student-status")
      .getByText("Not Approved", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Bob")
      .locator(".sp-teacher-student-status")
      .getByText("Private", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Dee")
      .locator(".sp-teacher-student-status p")
      .first()
      .getByText("Unavailable", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Dee")
      .locator(".sp-teacher-student-status p")
      .last()
      .getByText("Unavailable", { exact: true })
      .count(),
    1,
  );
  await page.getByRole("tab", { name: "In Progress" }).click();
  assert.equal(await student("Cara").count(), 1);
  assert.equal(await student("Alice").count(), 0);
  assert.equal(await student("Bob").count(), 0);
  assert.equal(await student("Dee").count(), 0);
  await page.getByRole("tab", { name: "Awaiting Approval" }).click();
  assert.equal(await student("Bob").count(), 1);
  assert.equal(await student("Cara").count(), 0);
  assert.equal(await student("Dee").count(), 0);
  await page.getByRole("tab", { name: /All Students/ }).click();
  assert.equal(await page.getByRole("button", { name: "View Progress" }).count(), 4);
  await page.route("**/?classId=**", (route) => route.fulfill({ body: "Student editor" }));
  await student("Alice").getByRole("button", { name: "View Progress" }).click();
  await page.waitForURL((url) => url.searchParams.get("projectId") === studentProjectId);
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get("assignmentId"), assignmentId);
  assert.equal(params.get("classId"), classId);
  assert.equal(params.get("studentId"), studentId);
  assert.equal(params.get("review"), "1");
  await page.goto(origin + "/home");
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  console.log("PASS assignment card shows details and student");
  await page.getByRole("button", { name: "Close project details" }).click();
  assert.equal(
    await page.getByRole("heading", { name: "Standalone", exact: true }).count(),
    1,
    "Unrelated standalone project remains available",
  );
  console.log("PASS unrelated standalone remains visible");
  console.log("PASS progress opens the selected student editor");
  await page.getByRole("heading", { name: "Standalone", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Museum", exact: true }).count(),
    1,
    "An assignment source must not appear as a duplicate standalone project",
  );
  assert.equal(
    await page.getByRole("heading", { name: "Retained class copy", exact: true }).count(),
    0,
  );
  console.log("PASS no duplicate source card");
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  await page.getByRole("link", { name: "School", exact: true }).click();
  await page.getByRole("heading", { name: "Organisation Details", exact: true }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Workspace", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "New Class", exact: true }).count(), 1);
  await page.getByRole("button", { name: "New Class", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New Class", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Class", exact: true }).click();
  await page.getByRole("option", { name: "History", exact: true }).click();
  await page
    .getByText("Choose existing student accounts from your organisation.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add Bob to class", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Add Student to Class", exact: true })
    .getByRole("button", { name: "Add to Class", exact: true })
    .click();
  await page.getByRole("rowheader", { name: "@Bob", exact: true }).waitFor();
  assert.equal(enrolled, true);
  assert.equal(await page.getByRole("heading", { name: "Add Students", exact: true }).count(), 0);
  await page
    .getByText("Your administrator creates accounts for new students.", { exact: true })
    .waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details", exact: true })
    .click();
  await page.waitForURL(
    (url) => url.pathname === "/home" && url.searchParams.get("assignmentId") === assignmentId,
  );
  await page.getByRole("link", { name: "School", exact: true }).click();
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/home" && url.searchParams.get("assignmentId") === assignmentId,
  );
  console.log(
    "PASS organisation context, class enrolment, existing-account hint, project navigation and close return",
  );
} finally {
  await browser?.close();
  await server.close();
}
