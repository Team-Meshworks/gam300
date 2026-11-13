import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const projectId = "aefea67c-caca-4300-923c-937f1c785578";
const classId = "15c0fbe1-a338-4030-9360-b04c494d6588";
const studentId = "25c0fbe1-a338-4030-9360-b04c494d6588";
const studentProjectId = "35c0fbe1-a338-4030-9360-b04c494d6588";
const session = {
  userId,
  orgId,
  displayName: "Teacher",
  mustChangePassword: false,
};

try {
  for (const [role, assetsStatus, missingSource] of [
    ["Educator", 200],
    ["Educator", 503],
    ["Educator", 200, true],
    ["Creator", 200],
    ["Creator", 503],
  ]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const writes = [];
    const assignments = [];
    let assetReads = 0;
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/auth/session") return route.fulfill({ json: { ...session, role } });
      if (path === "/api/v1/auth/csrf")
        return route.fulfill({ json: { requestToken: "test-token" } });
      if (path === "/api/v1/assets") {
        assetReads++;
        return assetsStatus === 200 ? route.fulfill({ json: [] }) : route.fulfill({ status: 503 });
      }
      if (path === "/api/v1/classes")
        return route.fulfill({
          json: { items: [{ id: classId, name: "Class" }], nextCursor: null },
        });
      if (path === `/api/v1/classes/${classId}/eligible-students`)
        return route.fulfill({
          json: {
            items: [{ userId: studentId, userName: "Alice", enrolled: true }],
            nextCursor: null,
          },
        });
      if (path === `/api/v1/classes/${classId}/assignments` && request.method() === "GET")
        return route.fulfill({
          json: {
            items: assignments.map((body) => ({
              ...body,
              assignmentId: body.requestId,
              projects: [
                {
                  studentId,
                  projectId: studentProjectId,
                  studentName: "Alice",
                },
              ],
            })),
            nextCursor: null,
          },
        });
      if (path === `/api/v1/classes/${classId}/assignments` && request.method() === "POST") {
        const body = request.postDataJSON();
        assignments.push(body);
        if (role === "Educator" && assignments.length === 1) return route.fulfill({ status: 409 });
        return route.fulfill({
          json: {
            assignmentId: body.requestId,
            projects: [{ studentId, projectId: studentProjectId }],
          },
        });
      }
      if (
        assignments.length &&
        path === `/api/v1/classes/${classId}/assignments/${assignments[0].requestId}`
      )
        return route.fulfill({
          json: {
            assignmentId: assignments[0].requestId,
            ...assignments[0],
            projects: [{ studentId, projectId: studentProjectId, studentName: "Alice" }],
          },
        });
      if (path === "/api/v1/projects" && request.method() === "GET")
        return route.fulfill({
          json: {
            items: writes.length
              ? [
                  {
                    projectId,
                    title: "Blank project",
                    revision: 3,
                    updatedAt: "2026-11-05T00:00:00Z",
                    archived: false,
                    permissions: {
                      canEdit: true,
                      canManage: true,
                      canPublish: true,
                    },
                  },
                ]
              : [],
            nextCursor: null,
          },
        });
      if (path === "/api/v1/projects" && request.method() === "POST") {
        writes.push(request.postDataJSON());
        return route.fulfill({
          status: 201,
          json: {
            projectId,
            revision: 0,
            updatedAt: "2026-11-05T00:00:00Z",
            archived: false,
          },
        });
      }
      return route.fulfill({ status: 404 });
    });
    await page.route(`**/?projectId=${projectId}`, (route) => route.fulfill({ body: "editor" }));
    await page.goto(origin + "/home");
    if (role === "Creator") {
      // Creators browse assigned projects without fetching the creation catalogue.
      await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
      await page.getByText("No projects are available yet.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "New project", exact: true }).count(), 0);
      assert.equal(
        await page.getByText("Manage projects and archives", { exact: true }).count(),
        0,
      );
      assert.equal(assetReads, 0);
      assert.deepEqual(writes, []);
      await page.goto(origin + "/new-project");
      await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
      assert.deepEqual(writes, [], "A direct route must not bypass creator creation restrictions");
      await page.close();
      continue;
    }
    if (role === "Educator") {
      if (missingSource) {
        await page.evaluate(
          ({ userId, projectId }) =>
            localStorage.setItem(
              `spatia.assignment.source:${userId}`,
              JSON.stringify({
                receipt: {
                  projectId,
                  revision: 0,
                  updatedAt: "2026-11-05T00:00:00Z",
                  archived: false,
                },
              }),
            ),
          { userId, projectId },
        );
      }
      await page.getByRole("link", { name: "New Project", exact: true }).click();
      await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: /^Class/ }).innerText(),
        "Select a class",
      );
      await page.getByLabel("Project title").fill("Discard this draft");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      const departure = page.getByRole("dialog", { name: "Leave this page?" });
      await departure.waitFor();
      assert.equal(await departure.getByRole("button").count(), 2);
      await departure.getByRole("button", { name: "Keep editing", exact: true }).click();
      assert.equal(await page.getByLabel("Project title").inputValue(), "Discard this draft");
      assert.equal(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
        true,
        "Keeping edits must retain native unload protection",
      );
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      let nativePrompts = 0;
      const dismissNative = async (dialog) => {
        nativePrompts++;
        await dialog.dismiss();
      };
      page.on("dialog", dismissNative);
      await departure.getByRole("button", { name: "Discard and leave", exact: true }).click();
      await page.waitForURL(`${origin}/home`).catch((error) => {
        throw new Error(JSON.stringify({ nativePrompts, url: page.url() }), { cause: error });
      });
      page.off("dialog", dismissNative);
      assert.equal(nativePrompts, 0, "Confirmed discard must not ask again through beforeunload");
      await page.getByRole("link", { name: "New Project", exact: true }).click();
      await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
      await page.getByLabel("Project title").fill("Blank project");
      await page.getByLabel("Project description").fill("Description");
      await page.getByLabel("Project instructions").fill("Instructions");
      await page.getByLabel(/^Due date/).fill("2027-12-01");
      await page.getByRole("combobox", { name: /^Class/ }).click();
      await page.getByRole("option", { name: "Class", exact: true }).click();
      await page.getByRole("checkbox", { name: /Alice/ }).check();
      await page.getByRole("button", { name: "Create project" }).click();
      if (missingSource) {
        await page.getByText(/project is no longer available or cannot be managed/i).waitFor();
        assert.equal(writes.length, 0);
        assert.equal(assignments.length, 0);
        assert.ok(
          await page.evaluate(
            (userId) => localStorage.getItem(`spatia.assignment.source:${userId}`),
            userId,
          ),
        );
        await page.getByRole("button", { name: "Start a new project" }).click();
        assert.equal(await page.getByLabel("Project title").inputValue(), "Blank project");
        assert.equal(
          await page.evaluate(
            (userId) => localStorage.getItem(`spatia.assignment.source:${userId}`),
            userId,
          ),
          null,
        );
        await page.close();
        continue;
      }
      await page.getByText(/assignment was not created/i).waitFor();
      await page.getByRole("button", { name: "Create project" }).click();
      await page.waitForURL(`${origin}/home`);
      await page.getByRole("heading", { name: "All Projects", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Blank project", exact: true }).first().waitFor();
      assert.equal(await page.getByRole("button", { name: /Open project for/ }).count(), 0);
      assert.deepEqual(writes, [{ title: "Blank project" }]);
      assert.equal(assignments.length, 2);
      assert.equal(assignments[1].sourceProjectId, projectId);
      assert.equal(assignments[0].sourceRevision, 0);
      assert.equal(assignments[1].sourceRevision, 3);
      assert.deepEqual(assignments[1].studentIds, [studentId]);
      assert.equal(assetReads, 0, "Educator assignment creation does not require the catalogue");
      await page.close();
      continue;
    }
  }
  console.log(
    "Educators can create blank assignments; creators retain the assigned-project entry boundary",
  );
} finally {
  await browser.close();
}
