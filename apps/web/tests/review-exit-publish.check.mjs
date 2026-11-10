import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
const server = await createServer({
  configFile: false,
  cacheDir: "test-results/vite-review-exit-publish",
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
const project = "11111111-1111-4111-8111-111111111111",
  student = "33333333-3333-4333-8333-333333333333",
  actor = "22222222-2222-4222-8222-222222222222",
  submission = "55555555-5555-4555-8555-555555555555",
  stamp = "2026-11-02T01:00:00Z";
const document = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
document.projectId = project;
const summary = {
  submissionId: submission,
  revision: 7,
  sequence: 1,
  submittedAt: stamp,
  dueAtUnixSeconds: 1793581199,
  isLate: true,
  isCurrentSubmission: true,
};
let reviews = [],
  decisions = [],
  decisionRequests = [],
  publishes = [],
  lost = true,
  conflict = false,
  unsupported = false,
  saveDenied = false,
  historyUnavailable = true;
let approvalLost = false;
let reviewReplyToLose = 0;
const reviewRequests = [];
let legacyFound = false;
let sessionActor = actor;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(6000);
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      body = () => req.postDataJSON();
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: sessionActor,
        displayName: "Teacher",
        role: "Educator",
        orgId: "44444444-4444-4444-8444-444444444444",
        mustChangePassword: false,
      });
    if (path === "/api/v1/auth/csrf") return reply({ requestToken: "csrf" });
    if (path.endsWith("/access")) {
      if (!legacyFound) return reply({ code: "unavailable" }, 404);
      return reply({
        publicationId: "77777777-7777-4777-8777-777777777777",
        projectId: project,
        audience: "Unlisted",
        viewerIds: [],
        hidden: false,
        revoked: false,
        deleted: false,
        archived: false,
        canManage: true,
      });
    }
    if (path.endsWith("/progress-reviews")) {
      if (req.method() === "POST") {
        if (saveDenied) return reply({ code: "project_not_found" }, 403);
        const b = body(),
          row = {
            id: b.reviewId,
            feedback: b.feedback,
            revision: b.expectedRevision,
            createdAt: stamp,
          };
        reviewRequests.push(b);
        if (!reviews.some((review) => review.id === row.id)) reviews.push(row);
        if (reviewRequests.length === reviewReplyToLose) return route.abort();
        return reply(row, 201);
      }
      return historyUnavailable
        ? reply({ code: "unavailable" }, 503)
        : reply({ items: reviews, nextCursor: null });
    }
    if (path.endsWith("/publications") && req.method() === "POST") {
      const b = body();
      publishes.push(b);
      if (conflict) return reply({ code: "revision_conflict" }, 409);
      if (unsupported) return reply({ code: "unsupported_publication_runtime" }, 422);
      if (lost) {
        lost = false;
        return route.abort();
      }
      return reply(
        {
          publicationId: b.publicationId,
          projectId: project,
          sourceRevision: 7,
          createdAt: stamp,
          visitorUrl: `https://spatia.example/p/${b.publicationId}`,
        },
        201,
      );
    }
    if (path.endsWith("/decisions") && req.method() === "POST") {
      const b = body();
      decisionRequests.push(b);
      const row = {
        id: b.decisionId,
        decisionId: b.decisionId,
        submissionId: submission,
        educatorId: actor,
        sequence: 1,
        outcome: b.outcome,
        feedback: b.feedback,
        decidedAt: stamp,
      };
      if (!decisions.length) decisions.push(row);
      if (approvalLost) {
        approvalLost = false;
        return route.abort();
      }
      return reply(row, 201);
    }
    if (path.endsWith("/submissions")) return reply({ items: [summary], nextCursor: null });
    if (path.endsWith("/" + submission))
      return reply({
        ...summary,
        projectId: project,
        studentId: student,
        document,
        assetReferences: [],
        latestDecision: decisions.at(-1) ?? null,
        decisions,
        nextCursor: null,
      });
    if (path.endsWith("/" + project))
      return reply({
        projectId: project,
        revision: 7,
        document,
        permissions: { canEdit: true, canManage: true, canPublish: true },
      });
    return reply({ code: "not_found" }, 404);
  });
  async function open(history = false) {
    await page.goto(origin + "/tests/review-exit-fixture.html" + (history ? "?history" : ""));
    const d = page.getByRole("dialog", { name: history ? "Reviews" : "Review submission" });
    await d.waitFor();
    return d;
  }
  const storageKey = `spatia-review-publication:${actor}:${project}`;
  async function recoverPublication(feedback) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: storageKey,
      value: {
        projectId: project,
        actorId: actor,
        studentId: student,
        submissionId: submission,
        decisionId: "66666666-6666-4666-8666-666666666666",
        publicationId: "77777777-7777-4777-8777-777777777777",
        revision: 7,
        feedback,
      },
    });
    return open();
  }
  let d = await open(true);
  const retryHistory = d.getByRole("button", { name: "Retry loading reviews" });
  await retryHistory.waitFor();
  historyUnavailable = false;
  await retryHistory.click();
  await d.getByText("No reviews yet.").waitFor();
  assert.equal(await retryHistory.count(), 0);
  await d.getByRole("button", { name: "Add Reviews" }).click();
  await d.getByLabel("New review").fill("Discard this staged review");
  await d.getByLabel("New review").press("Enter");
  assert.equal(reviews.length, 0, "Enter stages feedback without saving it");
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(reviews.length, 0, "Cancel discards staged feedback");
  d = await open(true);
  for (const text of ["Saved only", "Second saved review"]) {
    await d.getByRole("button", { name: "Add Reviews" }).click();
    await d.getByLabel("New review").fill(text);
    await d.getByLabel("New review").press("Enter");
  }
  assert.equal(reviews.length, 0);
  reviewReplyToLose = 2;
  await d.getByRole("button", { name: "Save Changes" }).click();
  await d.getByRole("button", { name: "Retry same request" }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(reviewRequests.length, 3);
  assert.equal(reviewRequests[1].reviewId, reviewRequests[2].reviewId);
  assert.notEqual(reviewRequests[0].reviewId, reviewRequests[2].reviewId);
  await page.waitForFunction(() => document.body.dataset.saved === "yes");
  assert.equal(reviews.length, 2);
  assert.equal(decisions.length, 0);
  assert.equal(publishes.length, 0);
  d = await open();
  assert.equal(await d.getByText("Saved only", { exact: true }).count(), 0);
  await d.getByLabel("Your review").fill("Keep this unsaved review");
  saveDenied = true;
  await d.getByRole("button", { name: "Save review" }).click();
  await d.getByRole("alert").waitFor();
  assert.equal(await d.getByText("Saved only", { exact: true }).count(), 0);
  assert.equal(await d.getByRole("button", { name: "Retry loading reviews" }).count(), 0);
  assert.equal(await d.getByLabel("Your review").inputValue(), "Keep this unsaved review");
  saveDenied = false;
  await d.getByLabel("Your review").fill("");
  d = await open();
  await d.getByLabel("Your review").fill("Approved for the student to publish");
  assert.equal(await d.getByRole("button", { name: "Approve and publish" }).count(), 0);
  approvalLost = true;
  await d.getByRole("button", { name: "Approve to publish", exact: true }).click();
  await d.getByRole("button", { name: "Retry same request" }).click();
  await d.getByText("Approval saved. The student can now publish the approved revision.").waitFor();
  assert.equal(decisions.length, 1);
  assert.equal(publishes.length, 0, "An approval retry never creates a publication");
  assert.deepEqual(decisionRequests[0], decisionRequests[1]);
  decisions = [];
  // Old in-flight approval-and-publication requests retain their exact intent
  d = await recoverPublication("Ready for publishing");
  await d.getByRole("button", { name: "Retry same request" }).click();
  await d.getByRole("button", { name: "Retry same request" }).waitFor();
  assert.equal(decisions.length, 1);
  assert.equal(publishes.length, 1);
  await d.getByRole("button", { name: "Retry same request" }).click();
  await d.getByRole("img", { name: "QR code for the publication link" }).waitFor();
  assert.equal(
    await d.getByLabel("Your review").isEditable(),
    false,
    "review must not accept unsavable text after publication",
  );
  assert.deepEqual(publishes[0], publishes[1]);
  assert.equal(publishes[0].intent.audience, "Unlisted");
  assert.equal(publishes[0].confirmedRevision, 7);
  // A definitive publication conflict must not leave an automatically restored retry.
  decisions = [];
  publishes = [];
  conflict = true;
  d = await recoverPublication("Approved before a concurrent edit");
  await d.getByRole("button", { name: "Retry same request" }).click();
  await d
    .getByRole("alert")
    .filter({ hasText: /review and approval were saved.*project changed/i })
    .waitFor();
  assert.equal(decisions.length, 1);
  assert.equal(publishes.length, 1);
  await page.reload();
  d = page.getByRole("dialog", { name: "Review submission" });
  await d.waitFor();
  assert.equal(await d.getByRole("button", { name: "Retry same request" }).count(), 0);
  assert.equal(publishes.length, 1, "Reload must not send a new publication");
  const legacy = {
    projectId: project,
    actorId: actor,
    studentId: student,
    submissionId: null,
    decisionId: "66666666-6666-4666-8666-666666666666",
    publicationId: "77777777-7777-4777-8777-777777777777",
    revision: 7,
    feedback: "Keep this earlier feedback",
  };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey,
    value: legacy,
  });
  await page.reload();
  d = page.getByRole("dialog", { name: "Review submission" });
  await d
    .getByText(/earlier publishing request/i)
    .first()
    .waitFor();
  await d.getByRole("button", { name: "Check earlier publication" }).click();
  await d
    .getByText(/could not be verified/i)
    .first()
    .waitFor();
  assert.equal(await d.getByRole("button", { name: "Acknowledge publication" }).count(), 0);
  assert.ok(await page.evaluate((key) => localStorage.getItem(key), storageKey));
  legacyFound = true;
  await d.getByRole("button", { name: "Check earlier publication" }).click();
  await d.getByRole("button", { name: "Acknowledge publication" }).waitFor();
  sessionActor = "88888888-8888-4888-8888-888888888888";
  await d.getByRole("button", { name: "Acknowledge publication" }).click();
  await d.getByText(/could not be safely cleared/i).waitFor();
  assert.ok(await page.evaluate((key) => localStorage.getItem(key), storageKey));
  sessionActor = actor;
  await d.getByRole("button", { name: "Acknowledge publication" }).click();
  await page.waitForFunction((key) => localStorage.getItem(key) === null, storageKey);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), null);
  assert.equal(await d.getByLabel("Your review").inputValue(), legacy.feedback);
  await page.reload();
  d = page.getByRole("dialog", { name: "Review submission" });
  await d.getByLabel("Your review").waitFor();
  await page.waitForFunction(
    (feedback) => document.querySelector("#progress-feedback")?.value === feedback,
    legacy.feedback,
  );
  assert.equal(publishes.length, 1, "Recovery must not publish again");
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey,
    value: legacy,
  });
  legacyFound = false;
  await page.reload();
  d = page.getByRole("dialog", { name: "Review submission" });
  await d.getByRole("button", { name: "Check earlier publication" }).click();
  await d
    .getByText(/could not be verified/i)
    .first()
    .waitFor();
  const abandon = d.getByRole("button", { name: "Stop tracking earlier request" });
  assert.equal(await abandon.isDisabled(), true);
  await d.getByRole("checkbox", { name: /may still exist/i }).check();
  await abandon.click();
  await page.waitForFunction((key) => localStorage.getItem(key) === null, storageKey);
  assert.equal(await d.getByLabel("Your review").inputValue(), legacy.feedback);
  assert.equal(publishes.length, 1, "Abandoning an uncertain request must not republish");
  await page.reload();
  await page.waitForFunction(
    (feedback) => document.querySelector("#progress-feedback")?.value === feedback,
    legacy.feedback,
  );

  conflict = false;
  unsupported = true;

  for (const legacy of [false, true]) {
    decisions = [];
    decisionRequests = [];
    publishes = [];
    d = await open();
    const intent = {
      projectId: project,
      actorId: actor,
      studentId: student,
      submissionId: submission,
      decisionId: "66666666-6666-4666-8666-666666666666",
      publicationId: "77777777-7777-4777-8777-777777777777",
      revision: 7,
      feedback: "Approved but publication rejected",
    };
    if (legacy) {
      decisions.push({
        id: intent.decisionId,
        decisionId: intent.decisionId,
        submissionId: submission,
        educatorId: actor,
        sequence: 1,
        outcome: "approved",
        feedback: intent.feedback,
        decidedAt: stamp,
      });
      await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: storageKey,
        value: intent,
      });
      await page.reload();
      d = page.getByRole("dialog", { name: "Review submission" });
      await d.getByRole("button", { name: "Retry same request" }).click();
    } else {
      d = await recoverPublication(intent.feedback);
      await d.getByRole("button", { name: "Retry same request" }).click();
    }
    await d
      .getByRole("alert")
      .filter({ hasText: /approval.*saved.*publication.*(?:reject|not publish)/i })
      .waitFor();
    assert.equal(
      decisions[0].feedback,
      intent.feedback,
      "Saved approval feedback remains in review history",
    );
    assert.equal(await d.getByText(intent.feedback, { exact: true }).count(), 0);
    assert.equal(await d.getByRole("button", { name: "Retry loading reviews" }).count(), 0);
    assert.equal(decisions.length, 1, "The approval is recorded once");
    assert.equal(decisionRequests.length, 1);
    assert.equal(publishes.length, 1);
    if (legacy) {
      assert.equal(decisionRequests[0].decisionId, intent.decisionId);
      assert.equal(publishes[0].publicationId, intent.publicationId);
    }
    assert.equal(await d.getByRole("button", { name: "Retry same request" }).count(), 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), null);
    await page.reload();
    d = page.getByRole("dialog", { name: "Review submission" });
    await d.waitFor();
    assert.equal(
      decisions[0].feedback,
      intent.feedback,
      "Saved approval feedback remains in review history",
    );
    assert.equal(await d.getByText(intent.feedback, { exact: true }).count(), 0);
    assert.equal(await d.getByRole("button", { name: "Retry same request" }).count(), 0);
    assert.equal(decisionRequests.length, 1, "Reload must not repeat approval");
    assert.equal(publishes.length, 1, "Reload must not repeat publication");
    assert.equal(decisions.length, 1);
  }
  console.log(
    "Teacher approval-only retry, recovered publication retry, and revision conflict passed",
  );
} finally {
  await browser?.close();
  await server.close();
}
