import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5183";
const browser = await launchBrowser({ target: origin });
const session = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "First Educator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  role: "Educator",
  mustChangePassword: false,
};
let current = session;
let sessionReads = 0;
let sessionFailure = false;
let logoutCalls = 0;
let holdNextSession = false;
let releaseSession;
let sessionStarted;
let holdLogout = false;
let releaseLogout;
let logoutStarted;
async function waitForSignal(signal, label) {
  await Promise.race([
    signal,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not start`)), 5000)),
  ]);
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(4000);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session") {
      sessionReads++;
      if (sessionFailure) return route.fulfill({ status: 503 });
      const snapshot = current;
      if (holdNextSession) {
        holdNextSession = false;
        sessionStarted();
        await new Promise((resolve) => {
          releaseSession = resolve;
        });
      }
      return route.fulfill(snapshot ? { json: snapshot } : { status: 401 });
    }
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (path === "/api/v1/auth/logout") {
      logoutCalls++;
      assert.equal(route.request().headers()["x-spatia-account"], current.userId);
      if (holdLogout) {
        logoutStarted();
        await new Promise((resolve) => {
          releaseLogout = resolve;
        });
        return route.abort();
      }
      current = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/admin/assets")
      return route.fulfill({
        json: {
          assets: [],
          policy: {
            extensions: [".glb"],
            maxBytes: 20971520,
            categories: { environment: null, model: ["Objects"] },
            canSubmit: true,
            canForceRemove: false,
          },
        },
      });
    if (path === "/api/v1/classes" || path === "/api/v1/projects")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/review`);
  await page.getByText("First Educator", { exact: true }).waitFor();
  const before = sessionReads;
  current = {
    ...session,
    userId: "bbf2b1d0-b388-4df8-a995-930148dcdd19",
    displayName: "Second Educator",
  };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("Second Educator", { exact: true }).waitFor();
  assert.ok(sessionReads > before, "A focused workspace must reverify the current session");
  assert.equal(await page.getByText("First Educator", { exact: true }).count(), 0);
  holdNextSession = true;
  const heldSession = new Promise((resolve) => {
    sessionStarted = resolve;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitForSignal(heldSession, "Session recheck");
  current = { ...session, displayName: "Third Educator" };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("Third Educator", { exact: true }).waitFor();
  releaseSession();
  await page.waitForTimeout(200);
  assert.equal(
    await page.getByText("Second Educator", { exact: true }).count(),
    0,
    "An older response cannot restore a previous actor",
  );
  assert.equal(await page.getByText("Third Educator", { exact: true }).isVisible(), true);

  holdLogout = true;
  const heldLogout = new Promise((resolve) => {
    logoutStarted = resolve;
  });
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await waitForSignal(heldLogout, "Logout");
  const logout = page.getByRole("button", { name: "Log Out", exact: true });
  assert.ok(
    (await logout.count()) === 0 || !(await logout.isVisible()) || (await logout.isDisabled()),
    "Logout is unavailable while a sign-out is in flight",
  );
  releaseLogout();
  await page.getByRole("alert").waitFor();
  assert.ok(
    (await logout.count()) === 0 || !(await logout.isVisible()) || (await logout.isDisabled()),
    "An uncertain sign-out requires revalidation before another action",
  );
  holdLogout = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Third Educator", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.waitForURL(`${origin}/login`);
  current = { ...session, displayName: "LongEducatorName".repeat(8) };
  await mkdir("../../.artifacts/account-header", { recursive: true });
  for (const path of ["home", "review"]) {
    await page.goto(`${origin}/${path}`);
    await page.getByText(current.displayName, { exact: true }).waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const brand = page.getByRole("link", { name: "Spatia home", exact: true });
      const button = page.getByRole("button", { name: "Log Out", exact: true });
      assert.equal(await brand.getAttribute("href"), "/home");
      await brand.focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await button.evaluate((node) => node === document.activeElement),
        true,
        `${path} logout follows brand in keyboard order`,
      );
      for (const control of [brand, button]) {
        const rect = await control.boundingBox();
        assert.ok(
          rect && rect.x >= 0 && rect.x + rect.width <= width,
          `${path} header control is clipped at ${width}`,
        );
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: `../../.artifacts/account-header/${path}-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.goto(`${origin}/new-project`);
  await page.getByLabel("Project title").fill("Preserved assignment");
  const callsBeforeCancel = logoutCalls;
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
  await page.getByRole("button", { name: "Keep editing" }).click();
  assert.equal(logoutCalls, callsBeforeCancel, "Canceling a dirty form must not post logout");
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.getByRole("dialog", { name: "Leave this page?" }).waitFor();
  sessionFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("alert")
    .filter({ hasText: /session.*verif|account.*verif/i })
    .waitFor();
  sessionFailure = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  assert.equal(await page.getByLabel("Project title").inputValue(), "Preserved assignment");
  assert.equal(logoutCalls, callsBeforeCancel);
  current = { ...session, role: "Administrator", orgId: null, displayName: "Administrator" };
  await page.goto(`${origin}/spaces?add=1`);
  const upload = page.getByRole("dialog", { name: "Upload 3D Space" });
  await upload.getByLabel("Source or provenance (optional)").fill("Unsent museum archive");
  sessionFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("alert")
    .filter({ hasText: /session.*verif|account.*verif/i })
    .waitFor();
  sessionFailure = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal(
    await upload.getByLabel("Source or provenance (optional)").inputValue(),
    "Unsent museum archive",
  );
  current = { ...session, role: "Creator", displayName: "Student" };
  await page.goto(`${origin}/home`);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  console.log("Account rechecks, stale responses and uncertain logout are guarded.");
} finally {
  await browser.close();
}
