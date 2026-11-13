import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacherA = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const teacherB = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07f";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
let actor = teacherA;
let classesStarted, release;
const classesRequest = new Promise((resolve) => {
  classesStarted = resolve;
});
const gate = new Promise((resolve) => {
  release = resolve;
});
const server = await createServer({
  cacheDir: "test-results/vite-teacher-choices-account-switch",
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
    if (path === "/api/v1/classes") {
      classesStarted();
      await gate;
      return route.fulfill({
        json: {
          items: [{ id: classId, name: "Teacher B private class", organizationId: org }],
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/projects") {
      await gate;
      return route.fulfill({
        json: {
          items: [
            {
              projectId: "de000000-0000-4000-8000-000000000002",
              title: "Teacher B private project",
              revision: 1,
              permissions: { canManage: true },
            },
          ],
          nextCursor: null,
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/new-project");
  await classesRequest;
  actor = teacherB;
  release();
  await page.getByText("Loading assignment choices…").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByText("Teacher B private class", { exact: true }).count(),
    0,
    "Choices from the new account must not appear in the old account workspace",
  );
  assert.equal(
    await page.getByLabel("Project title").count(),
    0,
    "The old account form must not remain available after an account switch",
  );
  console.log("Account switch during setup hides private choices and old form");
} finally {
  release();
  await browser?.close();
  await server.close();
}
