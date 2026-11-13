import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
const server = await createServer({
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
const doc = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
);
doc.scenes = [
  {
    ...doc.scenes[0],
    environmentAssetId: null,
    objects: [],
    groups: [],
    zones: [],
    viewpoints: [],
    rules: [],
  },
];
const projectId = doc.projectId,
  actor = "22222222-2222-4222-8222-222222222222",
  student = "33333333-3333-4333-8333-333333333333",
  classId = "44444444-4444-4444-8444-444444444444",
  assignmentId = "55555555-5555-4555-8555-555555555555";
let role = "Educator";
let developmentAssetsAllowed = false;
let releaseSave;
const saveGate = new Promise((resolve) => (releaseSave = resolve));
let saved = 0;
let revision = 0;
let savedDocument = structuredClone(doc);
const publications = [];
const submissionId = "77777777-7777-4777-8777-777777777777";
const submittedDocument = structuredClone(doc);
submittedDocument.title = "Submitted exhibition";
const secondScene = {
  ...structuredClone(doc.scenes[0]),
  id: "99999991-9999-4999-8999-999999999999",
  name: "Submitted second room",
  viewpoints: [
    {
      id: "99999992-9999-4999-8999-999999999999",
      name: "Arrival",
      camera: doc.scenes[0].startCamera,
    },
  ],
};
submittedDocument.scenes.push(secondScene);
submittedDocument.scenes[0].interactions = [
  { when: { type: "scene-starts" }, do: { type: "print-hi" } },
];
const previewAlerts = [];
const submittedSummary = {
  submissionId,
  revision: 0,
  sequence: 1,
  submittedAt: "2026-11-02T01:00:00Z",
  dueAtUnixSeconds: 1793581199,
  isLate: false,
  isCurrentSubmission: false,
};
savedDocument.title = "Newer draft, not the submitted exhibition";
revision = 1;

try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"] });
  let page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(15000);
  const mockApi = async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: role === "Educator" ? actor : student,
        orgId: role === "Administrator" ? null : "66666666-6666-4666-8666-666666666666",
        displayName: "Teacher",
        role,
        mustChangePassword: false,
        developmentAssetsAllowed,
      });
    if (path === "/api/v1/projects")
      return reply({
        items: [
          {
            projectId,
            title: "Student project",
            revision: 0,
            updatedAt: "2026-11-02T01:00:00Z",
            archived: false,
            permissions: { canEdit: true, canManage: true, canPublish: true },
          },
        ],
        nextCursor: null,
      });
    if (path === "/api/v1/auth/csrf") return reply({ requestToken: "csrf" });
    if (path === "/api/v1/assets" || path === `/api/v1/projects/${projectId}/assets`)
      return reply([]);
    if (path === `/api/v1/classes/${classId}/assignments/${assignmentId}`)
      return reply({
        assignmentId,
        revision: 1,
        title: "Museum",
        description: "",
        instructions: "",
        dueAtUnixSeconds: 1793581199,
        projects: [{ projectId, studentId: student, studentName: "Student One" }],
      });
    if (path.endsWith("/progress-reviews")) {
      if (req.method() === "POST") {
        const b = req.postDataJSON();
        saved++;
        await saveGate;
        return reply(
          {
            id: b.reviewId,
            feedback: b.feedback,
            revision: b.expectedRevision,
            createdAt: "2026-11-02T01:00:00Z",
          },
          201,
        );
      }
      return reply({ items: [], nextCursor: null });
    }
    if (path === "/api/v1/classes")
      return reply({
        items: [{ id: classId, name: "History class" }],
        nextCursor: null,
      });
    if (path === `/api/v1/classes/${classId}/assignments`)
      return reply({
        items: [
          {
            assignmentId,
            title: "Museum",
            dueAtUnixSeconds: 1793581199,
            projects: [{ projectId, studentId: student }],
          },
        ],
        nextCursor: null,
      });
    if (path === `/api/v1/classes/${classId}/roster`)
      return reply({
        items: [{ userId: student, userName: "Student One", accountActive: true }],
        nextCursor: null,
      });
    if (path.endsWith("/publication-readiness"))
      return reply({
        projectId,
        revision,
        state: "ApprovalRequired",
        completionConfirmed: false,
        approved: false,
      });
    if (path.endsWith("/publication-viewers")) return reply({ items: [], nextCursor: null });
    if (path.endsWith("/publications") && req.method() === "POST") {
      const body = req.postDataJSON();
      publications.push(body);
      return reply(
        {
          publicationId: body.publicationId,
          projectId,
          sourceRevision: 0,
          createdAt: "2026-11-02T01:00:00Z",
          visitorUrl: "https://spatia.example/p/" + body.publicationId,
        },
        201,
      );
    }
    if (path.endsWith(`/submissions/${submissionId}`))
      return reply({
        ...submittedSummary,
        projectId,
        studentId: student,
        document: submittedDocument,
        assetReferences: [],
        latestDecision: null,
        decisions: [],
        nextCursor: null,
      });
    if (path.endsWith("/submissions"))
      return reply({ items: role === "Educator" ? [submittedSummary] : [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/exhibition`)
      return reply({
        projectId,
        publicationId: submissionId,
        revision: 0,
        document: doc,
        assets: [],
      });
    if (path === `/api/v1/projects/${projectId}` && req.method() === "PUT") {
      const body = req.postDataJSON();
      saved++;
      await saveGate;
      savedDocument = body.document;
      revision = body.expectedRevision + 1;
      return reply({
        projectId,
        clientMutationId: body.clientMutationId,
        revision,
      });
    }
    if (path === `/api/v1/projects/${projectId}`)
      return reply({
        projectId,
        revision,
        document: savedDocument,
        permissions: {
          canEdit: true,
          canManage: role === "Educator",
          canPublish: true,
        },
      });
    return reply({}, 404);
  };
  const mockHome = (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Home fixture</title>",
    });
  await page.route("**/api/v1/**", mockApi);
  await page.route("**/home?**", mockHome);
  const url =
    origin +
    "/?" +
    new URLSearchParams({
      projectId,
      classId,
      assignmentId,
      studentId: student,
      review: "1",
    });
  page.on("dialog", async (dialog) => {
    previewAlerts.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Review", exact: true }).waitFor();
  const failures = [];
  async function check(name, action) {
    try {
      await action();
      console.log("PASS " + name);
    } catch (error) {
      failures.push(name + ": " + error.message);
      console.error("FAIL " + name + ": " + error.message);
    }
  }
  await check("teacher has a separate read-only project view", async () => {
    assert.equal(await page.getByRole("button", { name: "Review", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Leave editor" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Close student project" }).count(), 1);
    assert.equal(await page.getByRole("dialog").count(), 0);
  });
  await check(
    "teacher previews the submitted exhibition with working interactions and no writes",
    async () => {
      await page.waitForFunction(() =>
        document.querySelector(".facilitator-project-canvas .editor-shell.is-previewing"),
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".facilitator-project-header h1")?.textContent ===
          "Submitted exhibition",
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".viewport-status")?.textContent?.includes("Scene ready") ||
          document.querySelector(".viewport-stage canvas"),
      );
      assert.equal(
        await page.locator(".facilitator-project-header h1").textContent(),
        submittedDocument.title,
      );
      assert.notEqual(submittedDocument.title, savedDocument.title);
      for (let attempt = 0; attempt < 100 && !previewAlerts.includes("hi"); attempt++)
        await page.waitForTimeout(20);
      assert.ok(
        previewAlerts.includes("hi"),
        "The submitted scene-start interaction must run in educator preview",
      );
      const submittedRoom = page
        .getByRole("navigation", { name: "Scenes", exact: true })
        .getByRole("button", { name: "Submitted second room", exact: true });
      await submittedRoom.click();
      assert.equal(
        await submittedRoom.getAttribute("aria-pressed"),
        "true",
        "Scene selection must respond to one click",
      );
      assert.equal(saved, 0, "Read-only preview must never save a student project");
      assert.equal(publications.length, 0);
    },
  );
  // Separate browser storage prevents the teacher session leaking into the student scenario
  await page.close();
  role = "Creator";
  revision = 1;
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route("**/api/v1/**", mockApi);
  await page.route("**/home?**", mockHome);
  await page.goto(url);
  await page.getByText("Scene ready", { exact: true }).waitFor();
  await check("creator cannot use educator review controls", async () => {
    assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Review", exact: true }).count(), 0);
  });
  await page.goto(origin + "/?" + new URLSearchParams({ projectId }));
  await page.getByText("Scene ready", { exact: true }).waitFor();
  await check("student approval waits for unsaved work", async () => {
    assert.equal(
      await page.getByRole("button", { name: "Request approval", exact: true }).count(),
      1,
    );
    assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Review", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    await page.getByLabel("Scene name", { exact: true }).fill("Saved before approval");
    const saveRequest = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        new URL(request.url()).pathname === `/api/v1/projects/${projectId}`,
    );
    await page.getByRole("button", { name: "Rename scene", exact: true }).click();
    await page.getByRole("button", { name: "Request approval", exact: true }).click();
    const dialog = page.locator(".creator-approval-dialog");
    await saveRequest;
    assert.equal(new URL(page.url()).pathname, "/");
    // Keep submission unavailable while the save and current revision are still being verified
    assert.equal(await dialog.getAttribute("aria-busy"), "true");
    assert.equal(
      await dialog.getByRole("button", { name: "Mark as Completed", exact: true }).count(),
      0,
    );
    assert.equal(
      await dialog.locator(".creator-approval-actions button").last().isDisabled(),
      true,
    );
    assert.equal(publications.length, 0);
    releaseSave();
    await dialog.getByRole("heading", { name: "Finish your work first", exact: true }).waitFor();
    assert.equal(await dialog.getAttribute("aria-busy"), "false");
    assert.equal(
      await dialog.getByRole("button", { name: "Mark as Completed", exact: true }).isEnabled(),
      true,
    );
    assert.equal(saved, 1);
    assert.equal(savedDocument.scenes[0].name, "Saved before approval");
    await dialog.getByRole("button", { name: "Close request approval", exact: true }).click();
    await page.goto(origin + `/publish?projectId=${projectId}`);
  });
  await check("student publication route remains approval-gated", async () => {
    await page.getByRole("heading", { name: "Publish project", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Publish", exact: true }).isDisabled(),
      true,
    );
    assert.equal(publications.length, 0);
  });
  await page.goto(origin + "/review");
  await check("student submission remains reachable without Publish", async () => {
    await page.getByLabel("Class", { exact: true }).selectOption(classId);
    await page.getByLabel("Assignment", { exact: true }).selectOption(assignmentId);
    await page.getByLabel("Your assigned project", { exact: true }).selectOption(projectId);
    await page.getByRole("button", { name: "Submit for review", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Publish project/i }).count(), 0);
  });
  role = "Educator";
  await page.goto(origin + "/review");
  await check("teacher review route does not show old workspace", async () => {
    await page.waitForURL("**/home**");
    assert.equal(await page.getByRole("region", { name: "Submissions and reviews" }).count(), 0);
  });
  await page.unroute("**/home?**");
  await page.goto(origin + "/home");
  await check("teacher home hides submissions and reviews link", async () => {
    await page.getByRole("heading", { name: "All Projects", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Submissions and reviews" }).count(), 0);
  });
  await check("teacher home has no legacy management footer or standalone Publish", async () => {
    assert.equal(await page.getByText("Manage projects and archives", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Publish project", exact: true }).count(), 0);
  });
  developmentAssetsAllowed = true;
  savedDocument.scenes[0].environmentAssetId = "test-room-v1";
  submittedDocument.scenes[0].environmentAssetId = "test-room-v1";
  submittedDocument.scenes[1].environmentAssetId = "room-space1-v1";
  await page.goto(url);
  await check(
    "teacher opens the submitted packaged environments permitted by the server",
    async () => {
      await page.getByText("Scene ready", { exact: true }).waitFor();
      await page
        .getByRole("navigation", { name: "Scenes", exact: true })
        .getByRole("button", { name: "Submitted second room", exact: true })
        .click();
      await page.getByText("Scene ready", { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Review", exact: true }).isEnabled(),
        true,
      );
      await page.screenshot({ path: "test-results/teacher-packaged-environments.png" });
    },
  );
  developmentAssetsAllowed = false;
  await page.goto(url);
  await check(
    "teacher cannot load packaged environments when the server disallows them",
    async () => {
      await page.getByText("Expected an approved environment asset", { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Review", exact: true }).isDisabled(),
        true,
      );
    },
  );
  savedDocument.scenes[0].environmentAssetId = null;
  submittedDocument.scenes[0].environmentAssetId = null;
  submittedDocument.scenes[1].environmentAssetId = null;
  role = "Administrator";
  const writesBeforeAdmin = saved;
  const publicationsBeforeAdmin = publications.length;
  await page.goto(origin + "/?projectId=" + projectId);
  await check("admin opens the exhibition without editing or review controls", async () => {
    await page.waitForFunction(() =>
      document.querySelector(".facilitator-project-canvas .editor-shell.is-previewing"),
    );
    for (const name of ["Review", "Publish", "Save", "Request approval", "Leave editor"])
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      await page.locator("input:visible, textarea:visible, [contenteditable=true]:visible").count(),
      0,
    );
    assert.equal(
      await page.getByRole("link", { name: "Close student project" }).getAttribute("href"),
      "/admin/dashboard?view=projects",
    );
    await page.getByText("Scene ready", { exact: true }).waitFor();
    await page.screenshot({ path: "test-results/admin-readonly-project.png" });
    assert.equal(saved, writesBeforeAdmin);
    assert.equal(publications.length, publicationsBeforeAdmin);
  });
  assert.deepEqual(failures, []);
} finally {
  releaseSave?.();
  await browser?.close();
  await server.close();
}
