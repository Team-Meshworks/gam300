import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const projectId = process.env.SPATIA_REVIEW_PROJECT;
const classId = process.env.SPATIA_REVIEW_CLASS;
const unavailable = process.env.SPATIA_REVIEW_UNAVAILABLE === "true";
assert.ok(
  projectId && classId && process.env.SPATIA_REVIEW_STUDENT && process.env.SPATIA_REVIEW_EDUCATOR,
);
const server = await createServer({
  server: { port: 0, strictPort: false },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = "https://127.0.0.1:" + address.port;
  browser = await launchBrowser({ target: origin });
  const errors = [];
  async function login(userName, review = true) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/login");
    await page.getByLabel("Username", { exact: true }).fill(userName);
    await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL("**/home");
    if (!review) return page;
    await page.goto(origin + "/review");
    await page.getByLabel("Class", { exact: true }).selectOption(classId);
    await page.getByLabel("Assignment", { exact: true }).selectOption({ label: "Assignment" });
    await page.locator("#review-student").selectOption(projectId);
    await page.getByText("Current server-saved revision:", { exact: false }).waitFor();
    return page;
  }
  const student = await login(process.env.SPATIA_REVIEW_STUDENT);
  const savedBefore = await student.evaluate(
    async (id) => (await fetch("/api/v1/projects/" + id)).json(),
    projectId,
  );
  let teacher, assignmentId;
  if (!unavailable) {
    teacher = await login(process.env.SPATIA_REVIEW_EDUCATOR, false);
    const studentId = await student.evaluate(
      async () => (await (await fetch("/api/v1/auth/session")).json()).userId,
    );
    assignmentId = await teacher.evaluate(async (id) => {
      const data = await (await fetch(`/api/v1/classes/${id}/assignments?limit=20`)).json();
      return data.items.find((item) => item.title === "Assignment").assignmentId;
    }, classId);
    // Draft feedback belongs to the teacher dashboard, before any submission exists
    await teacher.goto(
      origin +
        "/home?" +
        new URLSearchParams({
          classId,
          assignmentId,
          studentId,
          reviewProjectId: projectId,
        }),
    );
    const dialog = teacher.getByRole("dialog", { name: "Review submission" });
    await dialog.getByLabel("Your review").fill("Add a map to the draft.");
    await dialog.getByRole("button", { name: "Save review", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await student.goto(origin + "/home");
    await student.locator(`#student-project-${projectId}`).click();
    const progressRead = await student.evaluate(async (id) => {
      const response = await fetch(`/api/v1/projects/${id}/progress-reviews?limit=20`);
      return { id, status: response.status, body: await response.text() };
    }, projectId);
    assert.equal(
      progressRead.status,
      200,
      `Student progress review read: ${JSON.stringify(progressRead)}`,
    );
    assert.match(progressRead.body, /Add a map to the draft/);
    await student
      .getByRole("region", { name: "Reviews" })
      .getByText("Add a map to the draft.")
      .waitFor();
    await student.goto(origin + "/review");
    await student.getByLabel("Class", { exact: true }).selectOption(classId);
    await student.getByLabel("Assignment", { exact: true }).selectOption({ label: "Assignment" });
    await student.locator("#review-student").selectOption(projectId);
    await student.getByText("Current server-saved revision:", { exact: false }).waitFor();
  }
  await student.getByRole("checkbox").check();
  await student.getByRole("button", { name: "Submit for review", exact: true }).click();
  await student.getByRole("button", { name: "Cancel", exact: true }).click();
  const before = await student.evaluate(
    async (id) => (await (await fetch("/api/v1/projects/" + id + "/submissions")).json()).items,
    projectId,
  );
  assert.equal(before.length, 0, "Cancellation creates no database submission");
  await student.getByRole("button", { name: "Submit for review", exact: true }).click();
  await student.getByRole("button", { name: "Confirm submission", exact: true }).click();
  await student.getByText("Late submission", { exact: true }).waitFor();
  const evidence = await student.evaluate(async (id) => {
    const list = await (await fetch("/api/v1/projects/" + id + "/submissions")).json();
    const detail = await (
      await fetch("/api/v1/projects/" + id + "/submissions/" + list.items[0].submissionId)
    ).json();
    const saved = await (await fetch("/api/v1/projects/" + id)).json();
    return { list, detail, saved };
  }, projectId);
  assert.equal(evidence.list.items.length, 1, "Submission is persisted");
  assert.equal(evidence.saved.revision, savedBefore.revision);
  assert.deepEqual(evidence.saved.document, savedBefore.document);
  assert.equal(evidence.detail.revision, savedBefore.revision);
  assert.deepEqual(evidence.detail.document, savedBefore.document);
  if (unavailable) {
    assert.deepEqual(
      evidence.detail.assetReferences,
      [],
      "Unavailable assets are not represented as retained snapshots",
    );
  } else {
    assert.ok(evidence.detail.assetReferences.length > 0, "Resolved asset references are recorded");
  }
  if (!teacher) teacher = await login(process.env.SPATIA_REVIEW_EDUCATOR, false);
  assignmentId = evidence.list.assignmentId;
  const studentId = evidence.detail.studentId;
  const homeReviewUrl =
    origin +
    "/home?" +
    new URLSearchParams({
      classId,
      assignmentId,
      studentId,
      reviewProjectId: projectId,
    });
  // Both complete and unavailable assets use the dashboard review route
  await teacher.goto(homeReviewUrl);
  const publication = teacher.getByRole("dialog", {
    name: "Review submission",
  });
  let publicationWrites = 0;
  teacher.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/v1/projects/${projectId}/publications`
    )
      publicationWrites++;
  });
  await publication.getByLabel("Your review").fill("The saved exhibition is ready.");
  await publication.getByRole("button", { name: "Approve to publish", exact: true }).click();
  await publication
    .locator(".sp-review-subtitle")
    .filter({ hasText: / · Approved$/ })
    .waitFor();
  assert.equal(publicationWrites, 0, "Approval alone must not request a publication");
  const approved = await teacher.evaluate(
    async ({ projectId, submissionId }) =>
      (await fetch(`/api/v1/projects/${projectId}/submissions/${submissionId}`)).json(),
    { projectId, submissionId: evidence.detail.submissionId },
  );
  assert.equal(approved.latestDecision.outcome, "approved");
  assert.equal(approved.latestDecision.feedback, "The saved exhibition is ready.");
  assert.equal(await publication.getByRole("button", { name: "Approve and publish" }).count(), 0);
  // The student owns the separate publication decision after teacher approval
  await student.goto(origin + `/publish?projectId=${projectId}`);
  await student.getByRole("heading", { name: "Publish project", exact: true }).waitFor();
  if (unavailable) {
    await student.getByText(/assets are (?:not available|unavailable) for publication/).waitFor();
  } else {
    await student
      .getByRole("combobox", { name: "Who can open this publication" })
      .selectOption("Unlisted");
    await student.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
    await student.getByRole("button", { name: "Publish", exact: true }).click();
    await student.getByRole("textbox", { name: "Publication link" }).waitFor();
  }
  assert.equal(publicationWrites, 0, "The educator never requests publication");
  await student.goto(origin + "/review");
  await student.getByLabel("Class", { exact: true }).selectOption(classId);
  await student.getByLabel("Assignment", { exact: true }).selectOption({ label: "Assignment" });
  await student.locator("#review-student").selectOption(projectId);
  await student.getByText("Current server-saved revision:", { exact: false }).waitFor();
  await student.getByRole("button", { name: "Refresh status", exact: true }).click();
  await student
    .getByRole("region", { name: "Educator feedback" })
    .getByText("The saved exhibition is ready.", { exact: true })
    .waitFor();
  assert.equal(
    await student.getByRole("button", { name: "Publish project", exact: true }).count(),
    0,
  );
  const saveStatus = await student.evaluate(async (id) => {
    const saved = await (await fetch("/api/v1/projects/" + id)).json();
    const token = await (await fetch("/api/v1/auth/csrf")).json();
    const response = await fetch("/api/v1/projects/" + id, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": token.requestToken,
      },
      body: JSON.stringify({
        expectedRevision: saved.revision,
        clientMutationId: crypto.randomUUID(),
        document: { ...saved.document, title: "Newer saved draft" },
      }),
    });
    return response.status;
  }, projectId);
  assert.equal(saveStatus, 200);
  await student.getByRole("button", { name: "Refresh status", exact: true }).click();
  await student
    .getByText("Historical submission — not approval of the current revision", {
      exact: true,
    })
    .waitFor();
  await student
    .getByRole("region", { name: "Submitted content" })
    .getByText("Student draft", { exact: true })
    .waitFor();
  const historical = await student.evaluate(
    async ({ projectId, submissionId }) => {
      return (await fetch(`/api/v1/projects/${projectId}/submissions/${submissionId}`)).json();
    },
    { projectId, submissionId: evidence.detail.submissionId },
  );
  assert.deepEqual(
    historical.document,
    savedBefore.document,
    "Later edits preserve submitted content",
  );
  assert.equal(
    historical.latestDecision.outcome,
    "approved",
    "Approval is retained for both asset scenarios",
  );
  await teacher.goto(homeReviewUrl);
  const historicalReview = teacher.getByRole("dialog", {
    name: "Review submission",
  });
  await historicalReview.waitFor();
  assert.equal(
    await historicalReview
      .getByRole("button", { name: "Approve to publish", exact: true })
      .isDisabled(),
    true,
  );
  const stale = await teacher.evaluate(async (id) => {
    const saved = await (await fetch(`/api/v1/projects/${id}`)).json();
    const token = await (await fetch("/api/v1/auth/csrf")).json();
    const response = await fetch(`/api/v1/projects/${id}/publications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": token.requestToken,
      },
      body: JSON.stringify({
        publicationId: crypto.randomUUID(),
        confirmedRevision: saved.revision - 1,
        intent: { audience: "Unlisted", viewerIds: [] },
      }),
    });
    return response.status;
  }, projectId);
  assert.equal(stale, 409, "A stale saved revision cannot be published");
  assert.deepEqual(errors, []);
  console.log(
    "Real HTTPS review UI and PostgreSQL checks passed; unavailable assets=" + unavailable,
  );
} finally {
  await browser?.close();
  await server.close();
}
