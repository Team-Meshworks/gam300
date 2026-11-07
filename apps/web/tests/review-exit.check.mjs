import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
const server = await createServer({
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(5000);
  let projectReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: "22222222-2222-4222-8222-222222222222",
          displayName: "Teacher",
          role: "Educator",
          orgId: "44444444-4444-4444-8444-444444444444",
          mustChangePassword: false,
        },
      });
    if (path.endsWith("/progress-reviews"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/submissions"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/11111111-1111-4111-8111-111111111111")) {
      projectReads++;
      return route.fulfill({ status: 503, json: { code: "unavailable" } });
    }
    return route.fulfill({ status: 404, json: { code: "unavailable" } });
  });
  await page.goto(origin + "/tests/review-exit-fixture.html");
  const dialog = page.getByRole("dialog", { name: "Review submission" });
  await dialog.waitFor();
  await page.waitForTimeout(500);

  assert.ok(projectReads > 0, "eligibility request was made");
  await dialog.getByRole("alert").waitFor();
  const retry = dialog.getByRole("button", {
    name: /retry.*(eligibility|submission|publication)/i,
  });
  assert.equal(await retry.count(), 1, "eligibility failure offers a targeted retry");
  await retry.click();
  assert.ok(projectReads > 1, "retry checks eligibility again");
  console.log("Review exit eligibility retry passed");
} finally {
  await browser?.close();
  await server.close();
}
