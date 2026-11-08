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
const bobId = "de000000-0000-4000-8000-000000000006";
const bobProjectId = "de000000-0000-4000-8000-000000000007";
const otherId = "de000000-0000-4000-8000-000000000005";
const server = await createServer({
  cacheDir: "test-results/vite-teacher-assignment-edit",
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
  let saved = null;
  const assignment = () => ({
    assignmentId,
    revision: saved ? 1 : 0,
    sourceProjectId: sourceId,
    title: saved?.title ?? "Museum",
    description: saved?.description ?? "Build a museum",
    instructions: saved?.instructions ?? "Add exhibits",
    dueAtUnixSeconds: saved?.dueAtUnixSeconds ?? 1796200000,
    projects: [
      { projectId: studentProjectId, studentId, studentName: "Alice" },
      ...(saved ? [] : [{ projectId: bobProjectId, studentId: bobId, studentName: "Bob" }]),
    ],
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (path.endsWith("/eligible-students"))
      return route.fulfill({
        json: {
          items: [
            { userId: studentId, userName: "Alice", enrolled: true },
            { userId: bobId, userName: "Bob", enrolled: true },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/assignments/" + assignmentId) && route.request().method() === "PATCH") {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { assignmentId, revision: 1 } });
    }
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
    if (path.endsWith("/assignments/" + assignmentId)) return route.fulfill({ json: assignment() });
    if (path.endsWith("/assignments"))
      return route.fulfill({ json: { items: [assignment()], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/home");
  const assignmentCard = page.locator("article").filter({ hasText: "2 student projects" });
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  await page.getByRole("button", { name: "Edit project details" }).click();
  await page.getByLabel("Project title").fill("Updated museum");
  await page.getByLabel(/^Due date/).fill("2027-01-12");
  assert.equal(await page.getByLabel(/^Due date/).getAttribute("type"), "date");
  await page.getByLabel("Project description").fill("New description");
  await page.getByLabel("Project instructions").fill("New instructions");
  await page.getByRole("checkbox", { name: /Bob/ }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Updated museum", { exact: true }).waitFor();
  assert.ok(saved && /^[0-9a-f-]{36}$/i.test(saved.mutationId));
  assert.equal(saved.expectedRevision, 0);
  assert.equal(saved.title, "Updated museum");
  assert.equal(saved.description, "New description");
  assert.equal(saved.instructions, "New instructions");
  assert.deepEqual(saved.studentIds, [studentId]);
  assert.equal(await page.getByText("Alice", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Bob", { exact: true }).count(), 0);
  console.log("Teacher assignment edit checks passed");
} finally {
  await browser?.close();
  await server.close();
}
