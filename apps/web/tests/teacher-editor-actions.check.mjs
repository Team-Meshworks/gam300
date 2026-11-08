import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
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
let releaseSave;
const saveGate = new Promise((resolve) => (releaseSave = resolve));
let saved = 0;
const publications = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: role === "Educator" ? actor : student,
        orgId: "66666666-6666-4666-8666-666666666666",
        displayName: "Teacher",
        role,
        mustChangePassword: false,
        developmentAssetsAllowed: false,
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
      return reply({ items: [{ id: classId, name: "History class" }], nextCursor: null });
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
    if (path.endsWith("/submissions")) return reply({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`)
      return reply({
        projectId,
        revision: 0,
        document: doc,
        permissions: {
          canEdit: true,
          canManage: role === "Educator",
          canPublish: role === "Educator",
        },
      });
    return reply({}, 404);
  });
  await page.route("**/home?**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Home fixture</title>" }),
  );
  const url =
    origin +
    "/?" +
    new URLSearchParams({ projectId, classId, assignmentId, studentId: student, review: "1" });
  await page.goto(url);
  await page.getByText("Scene ready", { exact: true }).waitFor();
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
  await check("teacher Publish opens submission review", async () => {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("dialog", { name: "Review submission" }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole("dialog", { name: /save|export/i }).count(), 0);
    const dialog = page.getByRole("dialog", { name: "Review submission" });
    assert.equal(await dialog.getByLabel("Your review").inputValue(), "");
    await dialog.getByRole("button", { name: "Approve and publish" }).click();
    await dialog.getByRole("img", { name: "QR code for the publication link" }).waitFor();
    assert.equal(publications.length, 1);
    assert.equal(publications[0].intent.teacherOverride, true);
    assert.equal(publications[0].confirmedRevision, 0);
    assert.match(
      await dialog.getByRole("textbox", { name: "Publication link" }).inputValue(),
      /spatia\.example\/p\//,
    );
  });
  await page
    .getByRole("dialog", { name: "Review submission" })
    .getByRole("button", { name: "Close dialog" })
    .click();
  await check("teacher Review opens history", async () => {
    await page.getByRole("button", { name: "Review", exact: true }).click({ timeout: 3000 });
    await page.getByRole("dialog", { name: "Reviews" }).waitFor({ timeout: 3000 });
  });
  await page
    .getByRole("dialog", { name: "Reviews" })
    .getByRole("button", { name: "Close dialog" })
    .click();
  role = "Creator";
  await page.goto(url);
  await page.getByText("Scene ready", { exact: true }).waitFor();
  await check("student editor hides Publish", async () => {
    assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 0);
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
  await page.goto(origin + "/home");
  await check("teacher home hides submissions and reviews link", async () => {
    await page.getByRole("navigation").first().waitFor();
    assert.equal(await page.getByRole("link", { name: "Submissions and reviews" }).count(), 0);
  });
  await check("teacher manage projects hides standalone Publish", async () => {
    await page.getByText("Manage projects and archives", { exact: true }).click();
    await page.getByRole("heading", { name: "Student project", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Publish project", exact: true }).count(), 0);
  });
  assert.deepEqual(failures, []);
} finally {
  releaseSave?.();
  await browser?.close();
  await server.close();
}
