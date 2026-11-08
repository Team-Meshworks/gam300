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
              projects: [{ studentId, projectId: studentProjectId, studentName: "Alice" }],
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
                    permissions: { canEdit: true, canManage: true, canPublish: true },
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
          json: { projectId, revision: 0, updatedAt: "2026-11-05T00:00:00Z", archived: false },
        });
      }
      return route.fulfill({ status: 404 });
    });
    await page.route(`**/?projectId=${projectId}`, (route) => route.fulfill({ body: "editor" }));
    const assetsLoaded =
      role === "Creator" &&
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/assets");
    await page.goto(origin + "/home");
    if (role === "Creator")
      await page.getByText("Manage projects and archives", { exact: true }).click();
    if (assetsLoaded)
      await assetsLoaded.catch(async (error) => {
        throw new Error(`Assets request did not occur: ${await page.locator("body").innerText()}`, {
          cause: error,
        });
      });
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
      await page.getByRole("link", { name: "+ New Project", exact: true }).click();
      await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
      await page.getByLabel("Project title").fill("Blank project");
      await page.getByLabel("Project description").fill("Description");
      await page.getByLabel("Project instructions").fill("Instructions");
      await page.getByLabel(/^Due date/).fill("2027-12-01");
      await page.getByLabel(/^Class/).selectOption(classId);
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
      await page.getByRole("heading", { name: "Project details", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Blank project", exact: true }).waitFor();
      await page.getByText("Alice", { exact: true }).waitFor();
      await page.getByRole("button", { name: "View Progress" }).waitFor();
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
    const create = page.getByRole("button", { name: "New project", exact: true });
    await create.waitFor();
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent.trim() === "New project" && !button.disabled,
          ),
        null,
        { timeout: 3000 },
      )
      .catch(() =>
        assert.fail(
          `New project should be enabled for ${role} with catalogue status ${assetsStatus}`,
        ),
      );
    await create.click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    assert.equal(
      await dialog
        .getByText(
          "Empty projects can be edited and assigned, but publishing is not yet available.",
          { exact: true },
        )
        .count(),
      1,
      "Empty projects explain the current publishing limitation",
    );
    await dialog.getByLabel("Project title").fill("Blank project");
    await dialog.getByRole("button", { name: "Create project" }).click();
    await page.waitForURL(`**/?projectId=${projectId}`);
    assert.deepEqual(writes, [{ title: "Blank project" }]);
    await page.close();
  }
  console.log("Educators and creators can create a blank project when spaces are empty");
} finally {
  await browser.close();
}
