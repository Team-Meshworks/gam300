import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacher = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const otherClassId = "b9f15e21-026d-4200-baca-0ba9bd411842";
const assignmentId = "de000000-0000-4000-8000-000000000001";
const studentId = "de000000-0000-4000-8000-000000000003";
const doc = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
);
const projectId = doc.projectId;
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  let sessionOrg = org;
  let sessionRole = "Educator";
  let refreshed = false;
  let delayRefresh = false;
  let releaseRefresh;
  let notifyRefresh;
  const refreshStarted = new Promise((resolve) => {
    notifyRefresh = resolve;
  });
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const assignment = (published) => ({
    assignmentId,
    revision: 0,
    title: "Museum",
    description: "",
    instructions: "",
    dueAtUnixSeconds: 1796200000,
    projects: [
      {
        projectId,
        studentId,
        studentName: "Alice",
        approvalStatus: published ? "approved" : "awaiting-approval",
        published,
      },
    ],
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (json) => route.fulfill({ json });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: teacher,
        displayName: "Ms Chew",
        orgId: sessionOrg,
        orgName: "School",
        role: sessionRole,
        mustChangePassword: false,
      });
    if (path === "/api/v1/classes")
      return reply({
        items: [
          { id: classId, name: "History", organizationId: org },
          { id: otherClassId, name: "Science", organizationId: org },
        ],
        nextCursor: null,
      });
    if (path === "/api/v1/projects") return reply({ items: [], nextCursor: null });
    if (path === `/api/v1/classes/${classId}/assignments`)
      return reply({ items: [assignment(false)], nextCursor: null });
    if (path === `/api/v1/classes/${otherClassId}/assignments`)
      return reply({
        items: [{ ...assignment(false), title: "Science project" }],
        nextCursor: null,
      });
    if (path === `/api/v1/classes/${classId}/assignments/${assignmentId}`) {
      refreshed = true;
      if (delayRefresh) {
        notifyRefresh();
        await refreshGate;
      }
      return reply(assignment(true));
    }
    if (path === `/api/v1/projects/${projectId}`)
      return reply({
        projectId,
        revision: 0,
        document: doc,
        permissions: { canEdit: true, canManage: true, canPublish: true },
      });
    if (path.endsWith("/submissions") || path.endsWith("/progress-reviews"))
      return reply({ items: [], nextCursor: null });
    return route.fulfill({ status: 404 });
  });
  await page.goto(
    `${origin}/home?${new URLSearchParams({ classId, assignmentId, studentId, reviewProjectId: projectId })}`,
  );
  await page.getByRole("dialog", { name: "Review submission" }).waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByText("Approval status: Approved", { exact: true }).waitFor();
  assert.equal(await page.getByText("Publication status: Published", { exact: true }).count(), 1);
  assert.equal(refreshed, true);
  await page.getByRole("button", { name: "Close project details" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details" })
    .click();
  assert.equal(
    await page.getByText("Publication status: Published", { exact: true }).count(),
    1,
    "Updated assignment remains cached after leaving details",
  );
  delayRefresh = true;
  await page.goto(
    `${origin}/home?${new URLSearchParams({ classId, assignmentId, studentId, reviewProjectId: projectId })}`,
  );
  await page.getByRole("dialog", { name: "Review submission" }).waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await refreshStarted;
  await page.getByRole("button", { name: "Close project details" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Science project" })
    .getByRole("button", { name: "View Details" })
    .click();
  const response = page.waitForResponse((r) =>
    r.url().includes(`/classes/${classId}/assignments/${assignmentId}`),
  );
  releaseRefresh();
  await response;
  await page.waitForTimeout(200);
  assert.equal(
    await page.getByRole("heading", { name: "Science project" }).count(),
    1,
    "A late refresh must not replace the selected assignment",
  );
  await page.getByRole("button", { name: "Close project details" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details" })
    .click();
  await page.getByText("Publication status: Published", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close project details" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Science project" })
    .getByRole("button", { name: "View Details" })
    .click();
  assert.equal(await page.getByRole("heading", { name: "Science project" }).count(), 1);
  assert.equal(
    await page.getByText("Publication status: Not published", { exact: true }).count(),
    1,
  );
  delayRefresh = false;
  await page.goto(
    `${origin}/home?${new URLSearchParams({ classId, assignmentId, studentId, reviewProjectId: projectId })}`,
  );
  await page.getByRole("dialog", { name: "Review submission" }).waitFor();
  sessionOrg = "c9f15e21-026d-4200-baca-0ba9bd411842";
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "latest assignment details could not be loaded" })
    .waitFor();
  assert.equal(
    await page.getByText("Publication status: Not published", { exact: true }).count(),
    1,
  );
  sessionOrg = org;
  await page.goto(
    `${origin}/home?${new URLSearchParams({ classId, assignmentId, studentId, reviewProjectId: projectId })}`,
  );
  await page.getByRole("dialog", { name: "Review submission" }).waitFor();
  sessionRole = "Creator";
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "latest assignment details could not be loaded" })
    .waitFor();
  assert.equal(
    await page.getByText("Publication status: Not published", { exact: true }).count(),
    1,
  );
  console.log("Teacher review refresh updates its own cache without replacing another selection");
} finally {
  await browser?.close();
  await server.close();
}
