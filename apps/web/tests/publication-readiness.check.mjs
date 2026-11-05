import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const browser = await launchBrowser({ target: origin });
const projectId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const userId = "8ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "aea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const session = {
  userId,
  role: "Educator",
  displayName: "Teacher",
  orgId,
  mustChangePassword: false,
};
let state = "ApprovalRequired";
let failRead = false;
let loseResponse = true;
const writes = [];
try {
  await mkdir("../../.artifacts/publication-readiness", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(7000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session") return route.fulfill({ json: session });
    if (path === "/api/auth/csrf") return route.fulfill({ json: { requestToken: "test" } });
    if (path === `/api/projects/${projectId}`)
      return route.fulfill({
        json: {
          projectId,
          revision: 4,
          document: { title: "Saved exhibition" },
          permissions: { canPublish: true },
        },
      });
    if (path === `/api/projects/${projectId}/publication-readiness`)
      return failRead
        ? route.fulfill({ status: 503 })
        : route.fulfill({
            json: {
              projectId,
              revision: 4,
              state,
              completionConfirmed: true,
              approved: state === "Ready",
            },
          });
    if (path === "/api/classes") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === `/api/projects/${projectId}/publications`) {
      writes.push(request.postDataJSON());
      if (loseResponse) return route.abort();
      return route.fulfill({
        status: 201,
        json: {
          publicationId: writes.at(-1).publicationId,
          projectId,
          sourceRevision: 4,
          createdAt: "2026-11-05T00:00:00Z",
          visitorUrl: `https://spatia.example/p/${writes.at(-1).publicationId}`,
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  const open = () => page.goto(`${origin}/publish?projectId=${projectId}`);
  const publish = page.getByRole("button", { name: "Publish", exact: true });
  await open();
  await page.getByText(/approval.*(?:required|before)|(?:required|needs).*approval/i).waitFor();
  assert.equal(await publish.isDisabled(), true);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `../../.artifacts/publication-readiness/approval-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForURL(`${origin}/home`);
  assert.equal(writes.length, 0);
  await open();
  for (const next of ["UnsupportedRuntime", "DependencyUnavailable"]) {
    state = next;
    await page.reload();
    await page
      .getByText(
        next === "UnsupportedRuntime"
          ? /cannot be published|unsupported/i
          : /unavailable|could not/i,
      )
      .waitFor();
    assert.equal(await publish.isDisabled(), true);
  }
  failRead = true;
  await page.reload();
  await page
    .getByText(/readiness.*(?:unavailable|could not)|(?:unavailable|could not).*readiness/i)
    .waitFor();
  assert.equal(await publish.isDisabled(), true);
  failRead = false;
  state = "Ready";
  await page.reload();
  await page.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  await publish.click();
  await page.getByText(/could not be confirmed/i).waitFor();
  state = "ApprovalRequired";
  loseResponse = false;
  await page.reload();
  await page.getByRole("button", { name: /retry publication/i }).click();
  await page.getByRole("link", { name: /open publication/i }).waitFor();
  assert.deepEqual(writes[1], writes[0]);
  console.log("Publication readiness gates and uncertain retry passed");
} finally {
  await browser.close();
}
