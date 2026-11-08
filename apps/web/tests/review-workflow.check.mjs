import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const server = await createServer({
  cacheDir: "test-results/vite-review-workflow",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = "http://127.0.0.1:" + address.port;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const document = JSON.parse(
    await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const projectId = document.projectId;
  const studentId = "11111111-1111-4111-8111-111111111111";
  const educatorId = "22222222-2222-4222-8222-222222222222";
  const classId = "33333333-3333-4333-8333-333333333333";
  const assignmentId = "44444444-4444-4444-8444-444444444444";
  const orgId = "55555555-5555-4555-8555-555555555555";
  const stamp = "2026-11-02T01:00:00Z";
  let role = "Creator",
    revision = 7,
    mode = "assets-unavailable";
  let submissions = [],
    decisions = [];
  const progressReviews = [];
  const writes = [];
  let denied = false,
    canPublish = true;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: role === "Creator" ? studentId : educatorId,
        role,
        orgId: role === "Administrator" ? null : orgId,
        displayName: role === "Creator" ? "Student One" : "Teacher One",
        mustChangePassword: false,
      });
    if (path === "/api/v1/auth/csrf") return reply({ requestToken: "test-csrf" });
    if (path === "/api/v1/classes")
      return reply({ items: [{ id: classId, name: "History class" }], nextCursor: null });
    if (path.endsWith("/assignments"))
      return reply({
        items: [
          {
            assignmentId,
            title: "Museum",
            dueAtUnixSeconds: 1793581200,
            projects: [{ projectId, studentId }],
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith("/roster"))
      return reply({
        items: [{ userId: studentId, userName: "Student One", accountActive: true }],
        nextCursor: null,
      });
    if (denied) return reply({ code: "project_not_found" }, 404);
    if (path.endsWith("/progress-reviews")) {
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        assert.equal(req.headers()["x-csrf-token"], "test-csrf");
        const item = {
          id: body.reviewId,
          feedback: body.feedback,
          revision: body.expectedRevision,
          createdAt: stamp,
        };
        progressReviews.push(item);
        return reply(item, 201);
      }
      return reply({ items: progressReviews, nextCursor: null });
    }
    if (path === "/api/v1/projects/" + projectId)
      return reply({
        projectId,
        revision,
        document: { ...document, title: "Current draft" },
        permissions: { canEdit: true, canManage: role === "Educator", canPublish },
      });
    const latestSequence = submissions.length;
    function detail(s) {
      const ds = decisions.filter((d) => d.submissionId === s.submissionId);
      return {
        ...s,
        isCurrentSubmission: s.sequence === latestSequence && s.revision === revision,
        projectId,
        studentId,
        document: { ...document, title: "Retained student work" },
        assetReferences: [],
        latestDecision: ds.at(-1) ?? null,
        decisions: ds,
        nextCursor: null,
      };
    }
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      writes.push({ path, body });
      assert.equal(req.headers()["x-csrf-token"], "test-csrf");
      if (path.endsWith("/decisions")) {
        const submissionId = path.split("/").at(-2);
        let stored = decisions.find((d) => d.id === body.decisionId);
        if (!stored) {
          stored = {
            id: body.decisionId,
            submissionId,
            educatorId,
            sequence: decisions.length + 1,
            outcome: body.outcome,
            feedback: body.feedback,
            decidedAt: stamp,
          };
          decisions.push(stored);
        }
        if (mode === "lost-decision") {
          mode = "success";
          return route.abort();
        }
        return reply({ ...stored, decisionId: stored.id }, 201);
      }
      if (mode === "assets-unavailable") return reply({ code: "review_assets_unavailable" }, 503);
      let stored = submissions.find((s) => s.submissionId === body.submissionId);
      if (!stored) {
        stored = {
          submissionId: body.submissionId,
          revision: body.expectedRevision,
          sequence: submissions.length + 1,
          submittedAt: stamp,
          dueAtUnixSeconds: 1793581199,
          isLate: true,
          isCurrentSubmission: true,
        };
        submissions.push(stored);
      }
      return reply({ ...stored, projectId }, 201);
    }
    if (path.endsWith("/submissions"))
      return reply({ items: submissions.map(detail), nextCursor: null });
    const found = submissions.find((s) => path.endsWith("/" + s.submissionId));
    if (found) return reply(detail(found));
    return reply({ code: "review_not_found" }, 404);
  });
  async function open() {
    await page.goto(origin + "/review");
    await page.getByLabel("Class", { exact: true }).selectOption(classId);
    await page.getByLabel("Assignment", { exact: true }).selectOption(assignmentId);
    await page
      .getByLabel(role === "Creator" ? "Your assigned project" : "Student project", { exact: true })
      .selectOption(projectId);
    await page.getByText("Current server-saved revision:", { exact: false }).waitFor();
  }
  await open();
  assert.equal(
    await page.getByRole("button", { name: "Submit for review", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(writes.length, 0, "Cancelling confirmation never mutates");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await page.getByRole("button", { name: "Confirm submission", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "assets are not ready" }).waitFor();
  assert.equal(submissions.length, 0);
  assert.equal(
    await page.getByRole("checkbox").isChecked(),
    false,
    "Refreshing resets confirmation",
  );
  mode = "success";
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await page.getByRole("button", { name: "Confirm submission", exact: true }).click();
  await page.getByText("Late submission", { exact: true }).waitFor();
  assert.equal(submissions.length, 1);
  assert.equal(await page.getByRole("button", { name: "Publish project" }).count(), 0);
  assert.equal(
    await page
      .getByRole("region", { name: "Submitted content" })
      .getByText("Retained student work", { exact: true })
      .count(),
    1,
  );
  role = "Administrator";
  await page.goto(origin + "/review");
  await page.getByRole("heading", { name: "Access denied" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Review workflow browser checks passed (HTTP fixtures; no production asset resolver).",
  );
} finally {
  await browser?.close();
  await server.close();
}
