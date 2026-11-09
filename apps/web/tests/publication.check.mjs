import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const browser = await launchBrowser({ target: origin });
const projectId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const actor = "8ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const student = "9ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const classId = "aea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const session = {
  userId: actor,
  role: "Creator",
  displayName: "Teacher",
  orgId: classId,
  mustChangePassword: false,
};
const requests = [];
let outcome = "unknown";
let canPublish = true;
let rosterAvailable = true;
let largeRoster = false;
let currentSession = session;
let classRequests = 0;
let logoutPosts = 0;
let releasePublish;
let notifyPublish;
const publishStarted = new Promise((resolve) => {
  notifyPublish = resolve;
});
const heldPublish = new Promise((resolve) => {
  releasePublish = resolve;
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/session") return route.fulfill({ json: currentSession });
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test" } });
    if (path === "/api/v1/auth/logout") {
      logoutPosts++;
      return route.abort();
    }
    if (path === `/api/v1/projects/${projectId}/publication-readiness`)
      return route.fulfill({
        json: { projectId, revision: 4, state: "Ready", completionConfirmed: true, approved: true },
      });
    if (path === `/api/v1/projects/${projectId}`)
      return route.fulfill({
        json: {
          projectId,
          revision: 4,
          document: { title: "Saved exhibition" },
          permissions: { canPublish },
        },
      });
    if (path === `/api/v1/projects/${projectId}/publication-viewers`) {
      if (!rosterAvailable) return route.fulfill({ status: 503 });
      const cursor = new URL(request.url()).searchParams.get("cursor");
      const items = largeRoster
        ? Array.from({ length: 101 }, (_, index) => ({
            userId: `9ea0882b-9365-4b9c-b8b8-${String(index + 1).padStart(12, "0")}`,
            userName: `Student ${index + 1}`,
          }))
        : [{ userId: student, userName: "Aisyah" }];
      return route.fulfill({
        json: cursor
          ? { items: items.slice(1), nextCursor: null }
          : { items: items.slice(0, 1), nextCursor: student },
      });
    }
    if (path.startsWith("/api/v1/classes")) {
      classRequests += 1;
      return route.fulfill({ status: 403 });
    }
    if (path === `/api/v1/projects/${projectId}/publications`) {
      assert.equal(request.headers()["x-spatia-account"], actor);
      const body = request.postDataJSON();
      requests.push(body);
      if (requests.length === 1) {
        notifyPublish();
        await heldPublish;
      }
      if (outcome === "unknown") return route.abort();
      if (outcome === "conflict")
        return route.fulfill({ status: 409, json: { code: "revision_conflict" } });
      if (outcome === "approval")
        return route.fulfill({ status: 409, json: { code: "approval_required" } });
      if (outcome === "unsupported")
        return route.fulfill({ status: 422, json: { code: "unsupported_publication_runtime" } });
      return route.fulfill({
        status: 201,
        json: {
          publicationId: body.publicationId,
          projectId,
          sourceRevision: 4,
          createdAt: "2026-11-05T00:00:00Z",
          visitorUrl: `https://spatia.example/p/${body.publicationId}`,
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/publish?projectId=${projectId}`);
  await page.getByRole("heading", { name: "Publish project" }).waitFor();
  await page.getByText("Saved exhibition", { exact: true }).waitFor();
  const qr = page.getByRole("img", { name: /QR code/i });
  assert.equal(await qr.count(), 0, "No QR code before publication succeeds");
  assert.equal(await page.getByText(/revision 4/i).isVisible(), true);
  await page.getByRole("checkbox", { name: /Aisyah/ }).check();
  const publish = page.getByRole("button", { name: "Publish", exact: true });
  assert.equal(await publish.isDisabled(), true);
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  let leavePrompt = false;
  const dismissDeparture = async (dialog) => {
    leavePrompt = true;
    await dialog.dismiss();
  };
  page.once("dialog", dismissDeparture);
  await page.getByRole("link", { name: "Spatia home" }).click();
  page.off("dialog", dismissDeparture);
  const keepEditing = page.getByRole("button", { name: "Keep editing" });
  if (await keepEditing.isVisible()) {
    leavePrompt = true;
    await keepEditing.click();
  }
  assert.equal(leavePrompt, true, "Leaving with unsent publication choices must ask first");
  assert.equal(await page.getByRole("checkbox", { name: /Aisyah/ }).isChecked(), true);
  assert.equal(
    await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).isChecked(),
    true,
  );
  await publish.click();
  await publishStarted;
  assert.equal(
    await page.getByRole("link", { name: "Spatia home" }).getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(await page.getByRole("button", { name: "Log Out", exact: true }).isDisabled(), true);
  await page
    .getByRole("button", { name: "Log Out", exact: true })
    .evaluate((button) => button.click());
  await page.waitForTimeout(200);
  assert.equal(logoutPosts, 0, "A pending publication must block header logout");
  releasePublish();
  await page.getByText(/could not be confirmed/i).waitFor();
  assert.equal(await page.getByRole("link", { name: /open publication/i }).count(), 0);
  assert.equal(await qr.count(), 0, "An uncertain publication must not expose a QR code");
  assert.deepEqual(requests[0].intent, { audience: "Authenticated", viewerIds: [student] });
  assert.equal(requests[0].confirmedRevision, 4);
  assert.equal(classRequests, 0);
  await page.reload();
  await page.getByText(/could not be confirmed/i).waitFor();
  assert.equal(await page.getByRole("link", { name: /open publication/i }).count(), 0);
  assert.equal(await qr.count(), 0, "An uncertain retry must not expose a QR code");
  outcome = "success";
  await page.getByRole("button", { name: /retry publication/i }).click();
  const link = page.getByRole("link", { name: /open publication/i });
  await link.waitFor();
  assert.deepEqual(requests[1], requests[0]);
  const committedUrl = `https://spatia.example/p/${requests[0].publicationId}`;
  assert.equal(await link.getAttribute("href"), committedUrl);
  assert.equal(
    await page.getByRole("textbox", { name: "Publication link", exact: true }).inputValue(),
    committedUrl,
  );
  assert.equal(
    await qr.isVisible(),
    true,
    "A committed publication should show an accessible QR code",
  );
  if (process.env.SPATIA_SHARE_SCREENSHOT) {
    await page.screenshot({ path: process.env.SPATIA_SHARE_SCREENSHOT, fullPage: true });
  }
  const linkField = page.getByRole("textbox", { name: "Publication link", exact: true });
  const copyButton = page.getByRole("button", { name: "Copy link" });
  await linkField.focus();
  await page.keyboard.press("Tab");
  assert.equal(await copyButton.evaluate((element) => element === document.activeElement), true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject() } });
  });
  await page.keyboard.press("Enter");
  await page.getByText("Copy the link from the field above.").waitFor();
  const decoderAvailable = await page.evaluate(() => "BarcodeDetector" in window);
  if (decoderAvailable) {
    const screenshot = await qr.screenshot();
    const decoded = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      return (await detector.detect(bitmap)).map((code) => code.rawValue);
    }, screenshot.toString("base64"));
    assert.deepEqual(decoded, [committedUrl], "QR must encode the committed publication URL");
  } else {
    console.log("QR decoding skipped: Chrome BarcodeDetector is unavailable.");
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.reload();
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  outcome = "unknown";
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/could not be confirmed/i).waitFor();
  const uncertainRequest = requests.at(-1);
  await page.reload();
  await page.getByText(/could not be confirmed/i).waitFor();
  outcome = "unsupported";
  await page.getByRole("button", { name: /retry publication/i }).click();
  await page.getByText(/cannot be published by the current runtime/i).waitFor();
  assert.deepEqual(
    requests.at(-1),
    uncertainRequest,
    "Retry must keep the original publication ID",
  );
  assert.equal(await page.getByRole("button", { name: /retry publication/i }).count(), 0);
  const requestCount = requests.length;
  await page.reload();
  await page.getByRole("heading", { name: "Publish project" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /retry publication/i }).count(), 0);
  assert.equal(requests.length, requestCount, "Reload must not resend the rejected request");
  canPublish = false;
  await page.reload();
  await page.getByText(/do not have permission to publish/i).waitFor();
  assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 0);
  canPublish = true;
  rosterAvailable = false;
  await page.reload();
  await page.getByText(/viewers could not be loaded/i).waitFor();
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  outcome = "conflict";
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/saved project has changed/i).waitFor();
  assert.deepEqual(requests.at(-1).intent.viewerIds, []);
  assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).isDisabled(),
    true,
  );
  await page.reload();
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  outcome = "approval";
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/needs approval.*current saved revision/i).waitFor();
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  currentSession = { ...session, userId: student };
  const countBeforeAccountChange = requests.length;
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/account changed/i).waitFor();
  assert.equal(requests.length, countBeforeAccountChange);
  rosterAvailable = true;
  largeRoster = true;
  currentSession = session;
  await page.reload();
  for (let index = 1; index <= 100; index += 1) {
    await page.getByRole("checkbox", { name: `Student ${index}`, exact: true }).check();
  }
  assert.equal(
    await page.getByRole("checkbox", { name: "Student 101", exact: true }).isDisabled(),
    true,
  );
  await page.getByText(/up to 100 viewers/i).waitFor();
  await page.getByRole("checkbox", { name: "Student 1", exact: true }).uncheck();
  assert.equal(
    await page.getByRole("checkbox", { name: "Student 101", exact: true }).isEnabled(),
    true,
  );
  // Anonymous audience choices carry no stale named viewers and require fresh confirmation
  for (const audience of ["Public", "Unlisted"]) {
    await page.reload();
    await page
      .getByRole("combobox", { name: "Who can open this publication" })
      .selectOption(audience);
    assert.equal(await page.getByRole("checkbox", { name: "Student 1", exact: true }).count(), 0);
    await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
    outcome = "conflict";
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByText(/saved project has changed/i).waitFor();
    assert.deepEqual(requests.at(-1).intent, { audience, viewerIds: [] });
  }
  rosterAvailable = false;
  largeRoster = false;
  currentSession = session;
  await page.reload();
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "QuotaExceededError");
    };
  });
  const countBeforeStorageFailure = requests.length;
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/could not safely store.*request/i).waitFor();
  assert.equal(requests.length, countBeforeStorageFailure);
  console.log(
    "Publication screen checks passed: saved revision, audience, uncertain retry, acknowledgement, permission and conflict.",
  );
} finally {
  await browser.close();
}
