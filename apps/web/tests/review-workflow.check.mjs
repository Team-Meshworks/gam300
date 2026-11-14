import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const workspaceFixture = "/tests/review-workspace-fixture.html";
const workspaceFixtureEntry =
  "/@fs/" +
  fileURLToPath(new URL("./review-workspace-fixture.tsx", import.meta.url))
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
const server = await createServer({
  plugins: [
    {
      name: "review-workspace-test-fixture",
      configureServer(vite) {
        vite.middlewares.use(workspaceFixture, async (_request, response, next) => {
          try {
            const source = await readFile(
              new URL("./review-workspace-fixture.html", import.meta.url),
              "utf8",
            );
            const html = await vite.transformIndexHtml(
              workspaceFixture,
              source.replace("./review-workspace-fixture.tsx", workspaceFixtureEntry),
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
  cacheDir: "test-results/vite-review-workflow",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  logLevel: "silent",
});
let browser, page;
const errors = [];
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = "http://127.0.0.1:" + address.port;
  browser = await launchBrowser({ target: origin });
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Review workflow page error:", error.stack ?? error.message);
  });
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
  let logoutPosts = 0;
  let allowLogout = false;
  let signedOut = false;
  let notifyLogout;
  const logoutAttempted = new Promise((resolve) => {
    notifyLogout = resolve;
  });
  let denied = false,
    canPublish = true,
    denyReviewContext = false,
    hideLinkedProject = false;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/v1/auth/session" && signedOut) return route.fulfill({ status: 401 });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: role === "Creator" ? studentId : educatorId,
        role,
        orgId: role === "Administrator" ? null : orgId,
        displayName: role === "Creator" ? "Student One" : "Teacher One",
        mustChangePassword: false,
      });
    if (path === "/api/v1/auth/csrf") return reply({ requestToken: "test-csrf" });
    if (path === "/api/v1/auth/logout") {
      logoutPosts++;
      notifyLogout();
      if (allowLogout) {
        signedOut = true;
        return route.fulfill({ status: 204 });
      }
      return route.abort();
    }
    if (path === `/api/v1/projects/${projectId}/publication-readiness`)
      return reply({
        projectId,
        revision,
        state: "ApprovalRequired",
        completionConfirmed: true,
        approved: false,
        missingCapabilities: [],
      });
    if (path === `/api/v1/projects/${projectId}/publication-viewers`)
      return reply({ items: [], nextCursor: null });
    if (path === "/api/v1/classes")
      return reply({ items: [{ id: classId, name: "History class" }], nextCursor: null });
    if (path.endsWith("/assignments"))
      return reply({
        items: [
          {
            assignmentId,
            title: "Museum",
            dueAtUnixSeconds: 1793581200,
            projects: hideLinkedProject ? [] : [{ projectId, studentId }],
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
    if (path.endsWith("/submissions")) {
      if (denyReviewContext && new URL(req.url()).searchParams.get("limit") === "1")
        return reply({ code: "review_not_found" }, 404);
      return reply({
        projectId,
        classId,
        assignmentId,
        items: submissions.map(detail),
        nextCursor: null,
      });
    }
    const found = submissions.find((s) => path.endsWith("/" + s.submissionId));
    if (found) return reply(detail(found));
    return reply({ code: "review_not_found" }, 404);
  });
  async function open() {
    await page.goto(origin + (role === "Educator" ? workspaceFixture : "/review"));
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
  const due = await page.evaluate(() =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(1793581199 * 1000),
    ),
  );
  assert.ok(await page.getByText(due, { exact: false }).count());
  assert.equal(submissions.length, 1);
  assert.equal(await page.getByRole("button", { name: "Publish project" }).count(), 0);
  assert.equal(
    await page
      .getByRole("region", { name: "Submitted content" })
      .getByText("Retained student work", { exact: true })
      .count(),
    1,
  );
  role = "Educator";
  // The editor's review controls have their own browser suite; capture this navigation boundary.
  await page.route(
    (url) =>
      url.origin === origin && url.pathname === "/" && url.searchParams.get("review") === "1",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Editor review target</title>",
      }),
  );
  await page.goto(`${origin}/publish?projectId=${projectId}`);
  await page.getByRole("link", { name: "Open submissions and reviews" }).click();
  await page.waitForURL((url) => url.pathname === "/" && url.searchParams.get("review") === "1");
  const linked = new URL(page.url()).searchParams;
  assert.equal(linked.get("projectId"), projectId);
  assert.equal(linked.get("classId"), classId);
  assert.equal(linked.get("assignmentId"), assignmentId);
  assert.equal(linked.get("studentId"), studentId);
  denyReviewContext = true;
  await page.goto(`${origin}/review?projectId=${projectId}`);
  await page
    .getByRole("alert")
    .filter({ hasText: "This project or submission is unavailable to your account." })
    .waitFor();
  assert.equal(await page.getByLabel("Class", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Retained student work", { exact: true }).count(), 0);
  denyReviewContext = false;
  hideLinkedProject = true;
  await page.goto(`${origin}/review?projectId=${projectId}`);
  await page
    .getByRole("alert")
    .filter({ hasText: "This project is no longer available in the selected assignment." })
    .waitFor();
  assert.equal(await page.getByText("Retained student work", { exact: true }).count(), 0);
  hideLinkedProject = false;
  // Exercise the retained review components independently of the educator route redirect.
  await open();
  await page.getByRole("button", { name: "Reviews", exact: true }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Review submission", exact: true });
  const dialogBounds = await reviewDialog.boundingBox();
  const closeBounds = await reviewDialog
    .getByRole("button", { name: "Close dialog" })
    .boundingBox();
  assert.ok(Math.abs(dialogBounds.width - 414) <= 1);
  assert.ok(closeBounds.x > dialogBounds.x + dialogBounds.width / 2);
  assert.equal(Math.round(closeBounds.width), 36);
  assert.equal(Math.round(closeBounds.height), 36);
  await reviewDialog
    .getByRole("textbox", { name: "Your review", exact: true })
    .fill("Add a map to your draft.");
  await reviewDialog.getByRole("button", { name: "Save review", exact: true }).click();
  await reviewDialog.waitFor({ state: "hidden" });
  assert.equal(progressReviews.length, 1, "Saving feedback persists a progress review");
  assert.equal(
    await reviewDialog.getByText("Add a map to your draft.", { exact: true }).count(),
    0,
    "The submission form keeps saved history in the separate Reviews view",
  );
  await page.getByRole("button", { name: "Reviews", exact: true }).click();
  await reviewDialog
    .getByRole("textbox", { name: "Your review", exact: true })
    .fill("Label the second exhibit.");
  await reviewDialog.getByRole("button", { name: "Save review", exact: true }).click();
  await reviewDialog.waitFor({ state: "hidden" });
  assert.equal(progressReviews.length, 2, "The submission form supports multiple reviews");
  assert.equal(decisions.length, 0, "Saving feedback does not approve the submission");
  const feedback = page.getByRole("textbox", { name: "Feedback", exact: true });
  await feedback.fill("Move the first exhibit closer.");
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  const result = await Promise.race([
    page
      .getByRole("dialog", { name: /leave/i })
      .waitFor()
      .then(() => "guarded"),
    logoutAttempted.then(() => "posted"),
  ]);
  assert.equal(result, "guarded", "Dirty feedback must prompt before logout");
  assert.equal(logoutPosts, 0, "Dirty feedback must not post logout before confirmation");
  await page.getByRole("button", { name: /keep editing/i }).click();
  assert.equal(await feedback.inputValue(), "Move the first exhibit closer.");
  await page.getByRole("button", { name: "Return with feedback", exact: true }).click();
  const beforeCancel = writes.length;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(writes.length, beforeCancel);
  assert.equal(await feedback.inputValue(), "Move the first exhibit closer.");
  mode = "lost-decision";
  await page.getByRole("button", { name: "Return with feedback", exact: true }).click();
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await page.getByRole("button", { name: "Check outcome", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Class", { exact: true }).isDisabled(),
    true,
    "Unknown write blocks switching",
  );
  await page.getByRole("button", { name: "Retry same request", exact: true }).click();
  await page.getByText("Returned for changes", { exact: true }).waitFor();
  assert.equal(decisions.length, 1);
  assert.deepEqual(writes.at(-1).body, writes.at(-2).body);
  role = "Creator";
  await open();
  await page
    .getByRole("region", { name: "Reviews" })
    .getByText("Add a map to your draft.")
    .waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "Educator feedback" })
      .getByText("Move the first exhibit closer.", { exact: true })
      .count(),
    1,
  );
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await page.getByRole("button", { name: "Confirm submission", exact: true }).click();
  await page.getByText("Awaiting educator review", { exact: true }).waitFor();
  role = "Educator";
  await open();
  await feedback.fill("Ready for review completion.");
  await page.getByRole("button", { name: "Approve submission", exact: true }).click();
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await page.getByText("Approved for this revision", { exact: true }).waitFor();
  const publish = page.getByRole("link", { name: "Publish project", exact: true });
  await publish.waitFor();
  assert.equal(
    await publish.getAttribute("href"),
    "/publish?projectId=" + encodeURIComponent(projectId),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await publish.scrollIntoViewIfNeeded();
  const bounds = await publish.boundingBox();
  assert.ok(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390,
    "Publish link fits mobile viewport",
  );
  await mkdir(new URL("../../../.artifacts/scrum-165/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(
      new URL("../../../.artifacts/scrum-165/review-publish-mobile.png", import.meta.url),
    ),
    fullPage: true,
  });
  await feedback.fill("Unsaved feedback stays here.");
  assert.equal(await publish.count(), 0, "Unsaved feedback prevents navigation");
  assert.equal(await page.getByRole("button", { name: "Publish project" }).isDisabled(), true);
  assert.equal(await feedback.inputValue(), "Unsaved feedback stays here.");
  await page.getByRole("button", { name: "Revoke approval" }).click();
  assert.equal(await publish.count(), 0, "Pending decision prevents navigation");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard feedback" }).click();
  canPublish = false;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await page
    .getByText("Publish permission:", { exact: false })
    .filter({ hasText: "not granted" })
    .waitFor();
  assert.equal(await publish.count(), 0, "Permission is required");
  canPublish = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await publish.waitFor();
  await publish.focus();
  assert.equal(await publish.evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/publish?projectId=*");
  await open();
  revision = 8;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page
    .getByText("Historical submission — not approval of the current revision", { exact: true })
    .waitFor();
  assert.equal(await publish.count(), 0, "Historical approval cannot publish");
  await feedback.fill("Keep recoverable feedback.");
  assert.equal(
    await page.getByRole("button", { name: "Approve submission", exact: true }).isDisabled(),
    true,
  );
  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "Review fits " + width,
    );
  }
  await mkdir(new URL("../../../.artifacts/scrum-165/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL("../../../.artifacts/scrum-165/review.png", import.meta.url)),
    fullPage: true,
  });
  denied = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "unavailable to your account" }).waitFor();
  assert.equal(await page.getByText("Retained student work", { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Approve submission", exact: true }).count(),
    0,
  );
  page.once("dialog", (dialog) => dialog.accept());
  role = "Administrator";
  await page.goto(origin + "/review");
  await page.getByRole("heading", { name: "Access denied" }).waitFor();
  role = "Educator";
  denied = false;
  await open();
  await feedback.fill("Discard this draft on logout.");
  allowLogout = true;
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Leave this page?" })
    .getByRole("button", { name: "Discard and leave" })
    .click();
  await page.waitForURL(`${origin}/login`);
  assert.equal(logoutPosts, 1, "Confirmed discard sends one logout");
  assert.equal(await feedback.count(), 0, "Signed-out page no longer exposes discarded feedback");
  assert.deepEqual(errors, []);
  console.log(
    "Review workflow browser checks passed (HTTP fixtures; no production asset resolver).",
  );
} catch (error) {
  console.error("Review workflow failure:", {
    url: page?.url(),
    pageErrors: errors,
    body: await page
      ?.locator("body")
      .innerText()
      .catch(() => "Page unavailable"),
    dialogs: await page
      ?.locator("dialog")
      .evaluateAll((dialogs) =>
        dialogs.map((dialog) => ({ open: dialog.open, text: dialog.innerText })),
      )
      .catch(() => []),
  });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
