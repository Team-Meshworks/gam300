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
  publishes = [],
  lost = true,
  conflict = false;
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
        const b = body(),
          row = {
            id: b.reviewId,
            feedback: b.feedback,
            revision: b.expectedRevision,
            createdAt: stamp,
          };
        reviews.push(row);
        return reply(row, 201);
      }
      return reply({ items: reviews, nextCursor: null });
    }
    if (path.endsWith("/publications") && req.method() === "POST") {
      const b = body();
      publishes.push(b);
      if (conflict) return reply({ code: "revision_conflict" }, 409);
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
  async function open() {
    await page.goto(origin + "/tests/review-exit-fixture.html");
    const d = page.getByRole("dialog", { name: "Review submission" });
    await d.waitFor();
    return d;
  }
  let d = await open();
  await d.getByLabel("Your review").fill("Saved only");
  await d.getByRole("button", { name: "Save review" }).click();
  await page.waitForFunction(() => document.body.dataset.saved === "yes");
  assert.equal(reviews.length, 1);
  assert.equal(decisions.length, 0);
  assert.equal(publishes.length, 0);
  d = await open();
  await d.getByLabel("Your review").fill("Ready for publishing");
  await d.getByRole("button", { name: "Approve and publish" }).click();
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
  d = await open();
  await d.getByLabel("Your review").fill("Approved before a concurrent edit");
  await d.getByRole("button", { name: "Approve and publish" }).click();
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
  const storageKey = `spatia-review-publication:${actor}:${project}`;
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
  console.log("Save-only, lost-publication retry, and revision conflict passed");
} finally {
  await browser?.close();
  await server.close();
}
