import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const projectId = process.env.SPATIA_REVIEW_PROJECT;
const classId = process.env.SPATIA_REVIEW_CLASS;
const unavailable = process.env.SPATIA_REVIEW_UNAVAILABLE === "true";
assert.ok(
  projectId && classId && process.env.SPATIA_REVIEW_STUDENT && process.env.SPATIA_REVIEW_EDUCATOR,
);
const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "silent" });
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
    await page.getByRole("heading", { name: /You.re signed in/ }).waitFor();
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
    const editor = new URLSearchParams({
      projectId,
      classId,
      assignmentId,
      studentId,
      review: "1",
    });
    await teacher.goto(origin + "/?" + editor);
    await teacher.getByText("Scene ready", { exact: true }).waitFor();
    await teacher.getByRole("button", { name: "Review", exact: true }).click();
    const dialog = teacher.getByRole("dialog", { name: "Reviews" });
    await dialog.getByLabel("New review").fill("Add a map to the draft.");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
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
  if (unavailable) {
    // Missing 3D assets must not prevent reviewing the retained submission in Home.
    await teacher.goto(homeReviewUrl);
  } else {
    await teacher.goto(origin + "/review?projectId=" + encodeURIComponent(projectId));
    const publish = teacher.getByRole("button", { name: "Publish", exact: true });
    const recovery = teacher.getByRole("dialog", { name: "A recovery copy is available" });
    await publish.or(recovery).waitFor();
    if (await recovery.isVisible()) {
      // The earlier editor visit retained a local checkpoint; review the submitted server copy.
      await recovery
        .getByRole("button", { name: "Use server version and discard recovery", exact: true })
        .click();
    }
    await publish.click();
  }
  const publication = teacher.getByRole("dialog", { name: "Review submission" });
  await publication.getByLabel("Your review").fill("The saved exhibition is ready.");
  await publication.getByRole("button", { name: "Approve and publish" }).click();
  if (unavailable) {
    await publication
      .getByRole("alert")
      .filter({ hasText: /approval.*saved.*publication.*rejected/i })
      .waitFor();
  } else {
    await publication.getByRole("textbox", { name: "Publication link" }).waitFor();
  }
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
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token.requestToken },
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
    .getByText("Historical submission — not approval of the current revision", { exact: true })
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
  const historicalReview = teacher.getByRole("dialog", { name: "Review submission" });
  await historicalReview
    .getByText("Publishing requires permission and a current submission ready for approval.")
    .waitFor();
  assert.equal(
    await historicalReview.getByRole("button", { name: "Approve and publish" }).isDisabled(),
    true,
  );
  const stale = await teacher.evaluate(async (id) => {
    const saved = await (await fetch(`/api/v1/projects/${id}`)).json();
    const token = await (await fetch("/api/v1/auth/csrf")).json();
    const response = await fetch(`/api/v1/projects/${id}/publications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token.requestToken },
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
