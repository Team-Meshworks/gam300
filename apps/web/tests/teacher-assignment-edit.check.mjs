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
  let superseded = false;
  const assignment = () => ({
    assignmentId,
    revision: superseded ? 2 : saved ? 1 : 0,
    sourceProjectId: sourceId,
    title: saved?.title ?? "Museum",
    description: saved?.description ?? "Build a museum",
    instructions: saved?.instructions ?? "Add exhibits",
    dueAtUnixSeconds: saved?.dueAtUnixSeconds ?? 1796200000,
    projects: [
      { projectId: studentProjectId, studentId, studentName: "Alice" },
      ...((saved?.studentIds ?? [studentId, bobId]).includes(bobId)
        ? [{ projectId: bobProjectId, studentId: bobId, studentName: "Bob" }]
        : []),
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
      if (superseded) return route.fulfill({ status: 409, json: { code: "conflict" } });
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
  const assignmentCard = page
    .locator("article")
    .filter({ has: page.locator(`[id="teacher-project-${classId}:${assignmentId}"]`) });
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  const beforeEdit = await page
    .getByRole("heading", { name: "Published Projects", exact: true })
    .boundingBox();
  await page.getByRole("button", { name: "Edit Due Date" }).click();
  const duringEdit = await page
    .getByRole("heading", { name: "Published Projects", exact: true })
    .boundingBox();
  assert.ok(Math.abs(beforeEdit.x - duringEdit.x) < 1, "Opening Edit does not shift the page");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("group", { name: "Edit Due Date", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Project title").count(), 0);
  assert.equal(await page.getByRole("textbox", { name: /^Project description/ }).count(), 0);
  assert.equal(await page.getByLabel(/^Due date/).getAttribute("type"), "datetime-local");
  await page.waitForFunction(() => document.activeElement?.id === "edit-assignment-due");
  assert.equal(
    await page.getByRole("button", { name: "Close project details", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Edit Project Description", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit Project Instructions" }).click();
  assert.equal(await page.getByLabel(/^Due date/).count(), 0);
  assert.equal(await page.getByRole("textbox", { name: /^Project instructions/ }).count(), 1);
  await page
    .getByRole("textbox", { name: /^Project instructions/ })
    .fill("Discard this inline edit");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Add exhibits", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Project Description" }).click();
  assert.equal(await page.getByRole("textbox", { name: /^Project instructions/ }).count(), 0);
  await page.getByRole("textbox", { name: /^Project description/ }).fill("New description");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page
    .getByRole("group", { name: "Edit Project Description", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByText("New description", { exact: true }).waitFor();
  assert.ok(saved && /^[0-9a-f-]{36}$/i.test(saved.mutationId));
  assert.equal(saved.expectedRevision, 0);
  assert.equal(saved.title, "Museum");
  assert.equal(saved.description, "New description");
  assert.equal(saved.instructions, "Add exhibits");
  assert.equal(saved.dueAtUnixSeconds, 1796200000, "Unchanged date preserves the exact deadline");
  assert.deepEqual(saved.studentIds, [studentId, bobId]);
  await page.evaluate(
    ({ teacher, classId, assignmentId, studentId }) => {
      localStorage.setItem(
        `spatia.assignment.edit:${teacher}:${assignmentId}`,
        JSON.stringify({
          actorId: teacher,
          classId,
          assignmentId,
          body: {
            mutationId: "de000000-0000-4000-8000-000000000099",
            expectedRevision: 0,
            title: "Uncertain edit",
            description: "Earlier description",
            instructions: "Earlier instructions",
            dueAtUnixSeconds: 1796200000,
            studentIds: [studentId],
          },
        }),
      );
    },
    { teacher, classId, assignmentId, studentId },
  );
  superseded = true;
  await page.reload();
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  await page.getByRole("button", { name: "Edit Due Date" }).click();
  const dialog = page.getByRole("group", { name: "Edit Due Date", exact: true });
  await dialog.getByRole("button", { name: "Retry same request" }).click();
  await dialog.getByRole("button", { name: "Review latest version" }).click();
  await dialog.getByText("Museum", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      ({ teacher, assignmentId }) =>
        localStorage.getItem(`spatia.assignment.edit:${teacher}:${assignmentId}`) !== null,
      { teacher, assignmentId },
    ),
    true,
  );
  await dialog.getByRole("button", { name: "Discard uncertain request and use latest" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(
      ({ teacher, assignmentId }) =>
        localStorage.getItem(`spatia.assignment.edit:${teacher}:${assignmentId}`),
      { teacher, assignmentId },
    ),
    null,
  );
  await page.getByRole("button", { name: "Edit Due Date" }).click();
  assert.equal(await page.getByLabel("Project title").count(), 0);
  assert.ok(await page.getByLabel(/^Due date/).inputValue());
  console.log("Teacher assignment edit checks passed");
} finally {
  await browser?.close();
  await server.close();
}
