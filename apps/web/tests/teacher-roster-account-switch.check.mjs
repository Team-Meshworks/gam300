import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacherA = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const teacherB = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07f";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
let actor = teacherA;
let rosterRequested;
const requested = new Promise((resolve) => {
  rosterRequested = resolve;
});
let releaseRoster;
const released = new Promise((resolve) => {
  releaseRoster = resolve;
});
const server = await createServer({
  cacheDir: "test-results/vite-teacher-account-switch",
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: actor,
          displayName: actor === teacherA ? "Teacher A" : "Teacher B",
          orgId: org,
          role: "Educator",
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/classes")
      return route.fulfill({
        json: { items: [{ id: classId, name: "History", organizationId: org }], nextCursor: null },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/eligible-students")) {
      rosterRequested();
      await released;
      return route.fulfill({
        json: {
          items: [
            {
              userId: "de000000-0000-4000-8000-000000000003",
              userName: "Private Student",
              enrolled: true,
            },
          ],
          nextCursor: null,
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/new-project");
  await page.getByRole("combobox", { name: "Class *", exact: true }).click();
  await page.getByRole("option", { name: "History", exact: true }).click();
  await requested;
  actor = teacherB;
  const rosterResponse = page.waitForResponse((response) =>
    response.url().includes("eligible-students"),
  );
  releaseRoster();
  await rosterResponse;
  await page.getByText("Loading enrolled students…").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByText("Private Student", { exact: true }).count(),
    0,
    "Roster names must not appear after account changes during loading",
  );
  console.log("Account switch during roster load hides private names");
} finally {
  releaseRoster();
  await browser?.close();
  await server.close();
}
