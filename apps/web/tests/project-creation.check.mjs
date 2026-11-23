import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
import { creationRecoveryFixture } from "./creation-recovery-fixture.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const session = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  orgId: null,
  role: "Administrator",
  displayName: "Admin",
  mustChangePassword: false,
};

try {
  await mkdir("../../.artifacts/project-creation", { recursive: true });
  const page = await browser.newPage();
  const receipts = creationRecoveryFixture();
  const writes = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    if (await receipts.handle(route, session.userId)) return;
    if (path === "/api/v1/auth/session") return route.fulfill({ json: session });
    if (path === "/api/v1/projects")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/home");
  await page.getByRole("heading", { name: "All Projects", exact: true }).waitFor();
  const pendingKey = "spatia.create:" + session.userId + ":import";
  await page.evaluate((key) => localStorage.setItem(key, "{partial"), pendingKey);
  await page.reload();
  const recovery = page.getByRole("region", { name: "Release pending import request" });
  const checkList = recovery.getByRole("button", { name: "Check current projects", exact: true });
  const release = recovery.getByRole("button", {
    name: "I checked the list; release this saved request",
    exact: true,
  });
  await checkList.click();
  await recovery.getByText("No accessible projects were returned.", { exact: true }).waitFor();
  await page.evaluate((key) => localStorage.setItem(key, "newer unreadable attempt"), pendingKey);
  await release.click();
  await recovery.getByText(/saved request changed in another tab/i).waitFor();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), pendingKey),
    "newer unreadable attempt",
  );

  await page.reload();
  await checkList.click();
  await recovery.getByText("No accessible projects were returned.", { exact: true }).waitFor();
  await release.click();
  await recovery.waitFor({ state: "detached" });
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null);
  assert.deepEqual(
    writes,
    [],
    "Releasing a local request must not create or acknowledge a project",
  );
  await page.close();

  // A focus recheck must not attach a delayed review to a newer server head.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    const racePage = await browser.newPage({ viewport });
    racePage.setDefaultTimeout(7000);
    const operationA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const operationB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
    const raceReceipt = (id) => ({
      projectId: id,
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    });
    let raceHead = operationA;
    let releaseReview;
    let reviewStarted;
    let headRead;
    let headSettled;
    let lateSessionDelivered;
    let bHeadRead = false;
    let holdReviewSession = false;
    const reviewHeld = new Promise((resolve) => (releaseReview = resolve));
    const reviewPending = new Promise((resolve) => (reviewStarted = resolve));
    const bRead = new Promise((resolve) => (headRead = resolve));
    const bSettled = new Promise((resolve) => (headSettled = resolve));
    const lateSession = new Promise((resolve) => (lateSessionDelivered = resolve));
    const acknowledgements = [];
    await racePage.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/auth/session") {
        const wasHeld = holdReviewSession;
        if (holdReviewSession) {
          holdReviewSession = false;
          reviewStarted();
          await reviewHeld;
        }
        await route.fulfill({ json: session });
        if (wasHeld) lateSessionDelivered();
        if (bHeadRead) headSettled();
        return;
      }
      if (path === "/api/v1/auth/csrf")
        return route.fulfill({ json: { requestToken: "test-token" } });
      if (path === "/api/v1/creation-operations/import" && request.method() === "GET") {
        const operationId = raceHead;
        await route.fulfill({
          json: {
            state: operationId === null ? "ready" : "unacknowledged",
            operationId,
            receipt:
              operationId === null
                ? null
                : raceReceipt(operationId === operationA ? projectA : projectB),
          },
        });
        if (operationId === operationB) {
          bHeadRead = true;
          headRead();
        }
        return;
      }
      if (path.startsWith("/api/v1/creation-operations/") && request.method() === "GET")
        return route.fulfill({ json: { state: "ready", operationId: null, receipt: null } });
      if (path.endsWith("/acknowledge")) {
        acknowledgements.push(path);
        raceHead = null;
        return route.fulfill({ status: 204 });
      }
      if (path === "/api/v1/projects/" + projectA) {
        holdReviewSession = true;
        return route.fulfill({
          json: { projectId: projectA, revision: 0, document: { title: "Review A" } },
        });
      }
      if (path === "/api/v1/projects/" + projectB)
        return route.fulfill({
          json: { projectId: projectB, revision: 0, document: { title: "Review B" } },
        });
      if (path === "/api/v1/projects")
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ status: 404 });
    });
    try {
      await racePage.goto(origin + "/home");
      const panel = racePage.getByRole("region", { name: "Release pending import request" });
      await panel.getByRole("button", { name: "Review recovered project" }).click();
      await reviewPending;
      raceHead = operationB;
      await racePage.evaluate(() => window.dispatchEvent(new Event("focus")));
      await bRead;
      await bSettled;
      await racePage.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      releaseReview();
      await lateSession;
      await racePage.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await panel
        .getByRole("button", { name: "Review recovered project" })
        .and(racePage.locator(":enabled"))
        .waitFor();
      assert.equal(
        await panel.getByText(/Recovered project: Review A/).count(),
        0,
        "A delayed review must not authorize the newly discovered operation",
      );
      assert.deepEqual(acknowledgements, []);
      assert.equal(new URL(racePage.url()).pathname, "/home");
      await panel.getByRole("button", { name: "Review recovered project" }).click();
      await panel.getByText(/Recovered project: Review B/).waitFor();
      await racePage.screenshot({
        path: `../../.artifacts/project-creation/stale-review-${viewport.width}.png`,
      });
      await panel.getByRole("button", { name: "Open this recovered project" }).click();
      await racePage.waitForURL("**/?projectId=" + projectB);
      assert.deepEqual(acknowledgements, [
        "/api/v1/creation-operations/import/" + operationB + "/acknowledge",
      ]);
    } finally {
      releaseReview();
      await racePage.close();
    }
  }
  console.log(
    "Project recovery opens the reviewed project and releases only the observed local request",
  );
} finally {
  await browser.close();
}
