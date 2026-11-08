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
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
        json: { items: [{ id: classId, name: "History", organizationId: org }], nextCursor: null },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({
        json: {
          items: [sourceId, otherId].map((projectId) => ({
            projectId,
            title: projectId === sourceId ? "Museum" : "Standalone",
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
          items: [{ userId: studentId, userName: "Alice", accountActive: true }],
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
                },
                {
                  projectId: "de000000-0000-4000-8000-000000000006",
                  studentId: "de000000-0000-4000-8000-000000000007",
                  studentName: "Bob",
                  approvalStatus: "awaiting-approval",
                  published: false,
                },
                {
                  projectId: "de000000-0000-4000-8000-000000000008",
                  studentId: "de000000-0000-4000-8000-000000000009",
                  studentName: "Cara",
                  approvalStatus: "not-submitted",
                  published: false,
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
  const assignmentCard = page.locator("article").filter({ hasText: "4 student projects" });
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  assert.equal(await page.getByText("Build a museum", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Add exhibits", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Alice", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "View Progress" }).count(), 4);
  const student = (name) =>
    page.locator(".sp-teacher-student").filter({ has: page.getByText(name, { exact: true }) });
  assert.equal(
    await student("Alice").getByText("Approval status: Approved", { exact: true }).count(),
    1,
  );
  assert.equal(
    await student("Alice").getByText("Publication status: Published", { exact: true }).count(),
    1,
  );
  assert.equal(
    await student("Bob").getByText("Approval status: Awaiting approval", { exact: true }).count(),
    1,
  );
  assert.equal(
    await student("Bob").getByText("Publication status: Not published", { exact: true }).count(),
    1,
  );
  assert.equal(
    await student("Dee").getByText("Approval status: Unavailable", { exact: true }).count(),
    1,
  );
  assert.equal(
    await student("Dee").getByText("Publication status: Unavailable", { exact: true }).count(),
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
  console.log("PASS no duplicate source card");
} finally {
  await browser?.close();
  await server.close();
}
