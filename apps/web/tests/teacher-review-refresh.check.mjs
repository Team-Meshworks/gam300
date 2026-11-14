import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacher = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const otherClassId = "b9f15e21-026d-4200-baca-0ba9bd411842";
const assignmentId = "de000000-0000-4000-8000-000000000001";
const studentId = "de000000-0000-4000-8000-000000000003";
const doc = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const projectId = doc.projectId;
const roomId = "de000000-0000-4000-8000-000000000004";
const room = await readFile(new URL("../../../assets/delivery/test-room.glb", import.meta.url));
doc.scenes = [doc.scenes[0]];
doc.scenes[0].objects = [];
doc.scenes[0].environmentAssetId = roomId;
const catalogue = [
  {
    id: roomId,
    name: "Review room",
    kind: "environment",
    url: `/api/v1/projects/${projectId}/assets/${roomId}/bytes`,
    sha256: createHash("sha256").update(room).digest("hex"),
    category: null,
    thumbnail: null,
  },
];
const server = await createServer({
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
let page;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  page = await browser.newPage();
  page.setDefaultTimeout(7000);
  let sessionOrg = org;
  let sessionRole = "Educator";
  let refreshed = false;
  let approvalWithdrawn = false;
  let removedDraft = false;
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
    projects: removedDraft
      ? []
      : [
          {
            projectId,
            studentId,
            studentName: "Alice",
            approvalStatus: approvalWithdrawn
              ? "revoked"
              : published
                ? "approved"
                : "awaiting-approval",
            published,
            isPublic: published,
          },
        ],
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (json) => route.fulfill({ json });
    if (path === `/api/v1/projects/${projectId}/assets`) return reply(catalogue);
    if (path === `/api/v1/projects/${projectId}/assets/${roomId}/bytes`)
      return route.fulfill({ body: room, contentType: "model/gltf-binary" });
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
  await page.locator(".sp-teacher-student-status").getByText("Approved", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".sp-teacher-student-status").getByText("Public", { exact: true }).count(),
    1,
  );
  assert.equal(refreshed, true);
  await page.getByRole("button", { name: "Close project details" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details" })
    .click();
  assert.equal(
    await page.locator(".sp-teacher-student-status").getByText("Public", { exact: true }).count(),
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
  await page.locator(".sp-teacher-student-status").getByText("Public", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close project details" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Science project" })
    .getByRole("button", { name: "View Details" })
    .click();
  assert.equal(await page.getByRole("heading", { name: "Science project" }).count(), 1);
  assert.equal(
    await page.locator(".sp-teacher-student-status").getByText("Private", { exact: true }).count(),
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
    await page.locator(".sp-teacher-student-status").getByText("Private", { exact: true }).count(),
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
    await page.locator(".sp-teacher-student-status").getByText("Private", { exact: true }).count(),
    1,
  );
  console.log("Teacher review refresh updates its own cache without replacing another selection");
  sessionRole = "Educator";
  const writes = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === `/api/v1/projects/${projectId}` &&
      request.method() !== "GET"
    )
      writes.push(request.method());
  });
  await page.goto(
    `${origin}/?${new URLSearchParams({ classId, assignmentId, studentId, projectId, review: "1" })}`,
  );
  await page.getByRole("button", { name: "Review", exact: true }).waitFor();
  await page
    .waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Review" && !button.disabled,
      ),
    )
    .catch(async (error) => {
      throw new Error(await page.locator("body").innerText(), { cause: error });
    });
  await page.getByRole("img", { name: "3D scene", exact: true }).waitFor();
  assert.equal(await page.locator(".editor-hotbar, .server-editor-shell").count(), 0);
  const canvas = page.getByRole("img", { name: "3D scene", exact: true });
  await page.locator(".facilitator-project-status").waitFor({ state: "hidden" });
  await mkdir("../../.artifacts/facilitator-check", { recursive: true });
  await page.screenshot({
    path: "../../.artifacts/facilitator-check/scene.png",
  });
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40, {
    steps: 8,
  });
  await page.mouse.up();
  for (const key of ["Delete", "Control+z", "Control+d", "Control+v", "Control+s"])
    await page.keyboard.press(key);
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => document.pointerLockElement === null);
  const originalCanvas = await canvas.elementHandle();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("dialog", { name: "Review submission" }).waitFor();
  await page.screenshot({
    path: "../../.artifacts/facilitator-check/review.png",
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
  assert.deepEqual(
    writes,
    [],
    "Inspection, shortcuts and opening reviews must not write the student's draft",
  );
  assert.equal(
    await canvas.evaluate((node, original) => node === original, originalCanvas),
    true,
    "Review controls retain the same scene canvas",
  );
  await page.getByRole("link", { name: "Close student project", exact: true }).click();
  await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("dialog", { name: "Review submission" }).count(),
    0,
    "Leaving inspection returns to details without opening a review",
  );
  console.log("Facilitator project opens a read-only scene with Review and no draft writes");
  let publicationState = {
    projectId,
    publicationCount: 1,
    hiddenCount: 0,
    publicCount: 1,
    publishingBlocked: false,
    removed: false,
  };
  const moderationWrites = [];
  await page.route("**/api/v1/projects/publication-moderation?**", (route) =>
    route.fulfill({ json: { items: [publicationState] } }),
  );
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({ json: { requestToken: "fixture-token" } }),
  );
  await page.route(
    new RegExp(`/api/v1/projects/(?:${projectId}/)?publication-moderation$`),
    async (route) => {
      assert.equal(route.request().method(), "POST");
      assert.equal(route.request().headers()["x-spatia-account"], teacher);
      const { action, projectIds } = route.request().postDataJSON();
      assert.equal(route.request().headers()["x-csrf-token"], "fixture-token");
      assert.ok(["hide", "show", "delete"].includes(action));
      if (new URL(route.request().url()).pathname === "/api/v1/projects/publication-moderation")
        assert.deepEqual(
          projectIds,
          [projectId],
          "Assignment-wide action targets its student project",
        );
      else assert.equal(projectIds, undefined);
      if (action === "hide" || action === "delete") approvalWithdrawn = true;
      moderationWrites.push(action);
      if (action === "delete") removedDraft = true;
      publicationState =
        action === "delete"
          ? {
              projectId,
              publicationCount: 0,
              hiddenCount: 0,
              publicCount: 0,
              publishingBlocked: true,
              removed: true,
            }
          : {
              projectId,
              publicationCount: publicationState.publicationCount,
              hiddenCount: action === "hide" ? publicationState.publicationCount : 0,
              publicCount: action === "hide" ? 0 : publicationState.publicationCount,
              publishingBlocked: action === "hide",
              removed: false,
            };
      await route.fulfill({ status: 204 });
    },
  );
  await page.goto(origin + "/home");
  await page
    .locator("article")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details" })
    .click();
  const assignmentActions = page.locator(".sp-teacher-assignment-actions");
  await assignmentActions.getByRole("button", { name: "Hide", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Hide Assignment Projects?" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.deepEqual(moderationWrites, []);
  for (const action of ["Hide", "Show"]) {
    await assignmentActions.getByRole("button", { name: action, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${action} Assignment Projects?` });
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
  assert.deepEqual(moderationWrites, ["hide", "show"]);
  moderationWrites.length = 0;
  await page
    .locator(".sp-teacher-student-actions")
    .getByRole("button", { name: "Hide", exact: true })
    .click();
  let confirmation = page.getByRole("dialog", { name: "Hide Student Project?" });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(moderationWrites, []);
  await page
    .locator(".sp-teacher-student-actions")
    .getByRole("button", { name: "Hide", exact: true })
    .click();
  confirmation = page.getByRole("dialog", { name: "Hide Student Project?" });
  await confirmation.getByRole("button", { name: "Hide", exact: true }).click();
  await confirmation.waitFor({ state: "detached" });
  await page.locator(".sp-teacher-student-status").getByText("Private", { exact: true }).waitFor();
  await page
    .locator(".sp-teacher-student-status")
    .getByText("Not Approved", { exact: true })
    .waitFor();
  await page
    .locator(".sp-teacher-student-actions")
    .getByRole("button", { name: "Show", exact: true })
    .click();
  confirmation = page.getByRole("dialog", { name: "Show Student Project?" });
  await confirmation.getByRole("button", { name: "Show", exact: true }).click();
  await confirmation.waitFor({ state: "detached" });
  await page.locator(".sp-teacher-student-status").getByText("Public", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".sp-teacher-student-status")
      .getByText("Not Approved", { exact: true })
      .count(),
    1,
  );
  await page
    .locator(".sp-teacher-student-actions")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  confirmation = page.getByRole("dialog", { name: "Delete Student Project?" });
  await page.screenshot({
    path: "../../.artifacts/facilitator-check/moderation.png",
  });
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmation.waitFor({ state: "detached" });
  await page
    .locator(".sp-teacher-student-actions")
    .getByRole("button", { name: "Delete", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await page
      .locator(".sp-teacher-student-actions")
      .getByRole("button", { name: "Delete", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(moderationWrites, ["hide", "show", "delete"]);
  removedDraft = false;
  publicationState = {
    projectId,
    publicationCount: 0,
    hiddenCount: 0,
    publicCount: 0,
    publishingBlocked: false,
    removed: false,
  };
  await page.goto(origin + "/home");
  await page
    .locator("article")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details" })
    .click();
  const hideDraft = page
    .locator(".sp-teacher-student-actions")
    .getByRole("button", { name: "Hide", exact: true });
  assert.equal(
    await hideDraft.getAttribute("title"),
    "Block publishing; the student can keep editing",
  );
  for (const action of ["Hide", "Show", "Delete"]) {
    await page
      .locator(".sp-teacher-student-actions")
      .getByRole("button", { name: action, exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: `${action} Student Project?` });
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      publicationState.publicationCount,
      0,
      "Draft moderation must not create an edition",
    );
    if (action !== "Delete")
      await page
        .locator(".sp-teacher-student-actions")
        .getByRole("button", { name: action === "Hide" ? "Show" : "Hide", exact: true })
        .waitFor();
  }
  await page.locator(".sp-teacher-student").waitFor({ state: "detached" });
  assert.deepEqual(moderationWrites, ["hide", "show", "delete", "hide", "show", "delete"]);
  assert.deepEqual(
    writes,
    [],
    "Publication moderation must not save or delete the student's draft",
  );
  console.log(
    "Facilitator Hide/Show/Delete requires confirmation and updates publication controls without draft writes",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
