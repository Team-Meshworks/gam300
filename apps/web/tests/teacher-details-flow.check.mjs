import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacher = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const scienceId = "b9f15e21-026d-4200-baca-0ba9bd411842";
const assignmentId = "de000000-0000-4000-8000-000000000001";
const sourceId = "de000000-0000-4000-8000-000000000002";
const studentId = "de000000-0000-4000-8000-000000000003";
const studentProjectId = "de000000-0000-4000-8000-000000000004";
const otherId = "de000000-0000-4000-8000-000000000005";
const server = await createServer({
  cacheDir: "test-results/vite-teacher-details",
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  let enrolled = false;
  let latestAssignment;
  let holdRosterRefresh = false;
  let releaseRosterRefresh;
  let markRosterRefreshStarted;
  const rosterRefreshStarted = new Promise((resolve) => {
    markRosterRefreshStarted = resolve;
  });
  const rosterRefreshGate = new Promise((resolve) => {
    releaseRosterRefresh = resolve;
  });
  let moderationAvailable = false;
  const removedProjects = new Set();
  const blockedProjects = new Set();
  const moderationWrites = [];
  const bulkModerationRequests = [];
  let releaseHistory;
  const historyGate = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  const enrolId = "de000000-0000-4000-8000-000000000006";
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/projects/" + studentProjectId)
      return route.fulfill({ json: { projectId: studentProjectId, revision: 1 } });
    if (path === "/api/v1/projects/" + studentProjectId + "/submissions")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v1/projects/" + studentProjectId + "/progress-reviews") {
      await historyGate;
      return route.fulfill({
        json: {
          items: Array.from({ length: 4 }, (_, i) => ({
            id: "aa000000-0000-4000-8000-00000000000" + i,
            feedback: "Saved review " + i,
            revision: 1,
            createdAt: "2026-11-01T00:00:00Z",
          })),
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/projects/publication-moderation" && route.request().method() === "POST") {
      const { projectIds, action } = route.request().postDataJSON();
      assert.ok(Array.isArray(projectIds) && projectIds.length > 0);
      assert.equal(new Set(projectIds).size, projectIds.length);
      assert.ok(["hide", "show", "delete"].includes(action));
      assert.equal(route.request().headers()["x-csrf-token"], "test-token");
      assert.equal(route.request().headers()["x-spatia-account"], teacher);
      bulkModerationRequests.push({ projectIds, action });
      for (const id of projectIds) {
        moderationWrites.push({ id, action });
        if (action === "delete") removedProjects.add(id);
        if (action === "hide") blockedProjects.add(id);
        if (action === "show") blockedProjects.delete(id);
      }
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/projects/publication-moderation") {
      if (!moderationAvailable) return route.fulfill({ status: 503, json: {} });
      const ids = new URL(route.request().url()).searchParams.get("ids").split(",");
      return route.fulfill({
        json: {
          items: ids.map((id) => ({
            projectId: id,
            publicationCount: id === studentProjectId ? 1 : 0,
            publicCount:
              id === studentProjectId && !blockedProjects.has(id) && !removedProjects.has(id)
                ? 1
                : 0,
            hiddenCount:
              id === studentProjectId && blockedProjects.has(id) && !removedProjects.has(id)
                ? 1
                : 0,
            publishingBlocked: blockedProjects.has(id),
            removed: removedProjects.has(id),
          })),
        },
      });
    }
    const moderation = /^\/api\/v1\/projects\/([0-9a-f-]+)\/publication-moderation$/.exec(path);
    if (moderation && route.request().method() === "POST") {
      const { action } = route.request().postDataJSON();
      assert.equal(route.request().headers()["x-csrf-token"], "test-token");
      assert.equal(route.request().headers()["x-spatia-account"], teacher);
      moderationWrites.push({ id: moderation[1], action });
      if (action === "delete") removedProjects.add(moderation[1]);
      if (action === "hide") blockedProjects.add(moderation[1]);
      if (action === "show") blockedProjects.delete(moderation[1]);
      return route.fulfill({ status: 204 });
    }
    if (
      path === "/api/v1/classes/" + classId + "/assignments/" + assignmentId &&
      holdRosterRefresh
    ) {
      markRosterRefreshStarted();
      await rosterRefreshGate;
    }
    if (path === "/api/v1/classes/" + classId + "/assignments/" + assignmentId && latestAssignment)
      return route.fulfill({
        json: {
          ...latestAssignment,
          projects: latestAssignment.projects.filter((p) => !removedProjects.has(p.projectId)),
        },
      });

    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (
      path === `/api/v1/classes/${classId}/members/${enrolId}` &&
      route.request().method() === "PUT"
    ) {
      assert.equal(route.request().headers()["x-csrf-token"], "test-token");
      enrolled = true;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/eligible-students"))
      return route.fulfill({
        json: {
          items: [
            { userId: studentId, userName: "Alice", enrolled: true },
            { userId: enrolId, userName: "Bob", enrolled },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: teacher,
          displayName: "Ms Chew",
          orgId: org,
          orgName: "School",
          role: "Educator",
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/classes")
      return route.fulfill({
        json: {
          items: [
            { id: classId, name: "History", organizationId: org },
            { id: scienceId, name: "Science", organizationId: org },
            {
              id: "c9f15e21-026d-4200-baca-0ba9bd411842",
              name: "Empty class",
              organizationId: org,
            },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({
        json: {
          items: [
            sourceId,
            otherId,
            "de000000-0000-4000-8000-000000000021",
            "de000000-0000-4000-8000-000000000022",
          ].map((projectId) => ({
            projectId,
            title:
              projectId === sourceId
                ? "Museum"
                : projectId === otherId
                  ? "Standalone"
                  : "Retained class copy",
            isClassProject: projectId !== otherId,
            revision: 1,
            updatedAt: "2026-11-01T00:00:00Z",
            archived: false,
            permissions: { canEdit: true, canManage: true, canPublish: false },
          })),
          nextCursor: null,
        },
      });
    if (path.endsWith("/roster"))
      return route.fulfill({
        json: {
          items: [
            {
              userId: studentId,
              userName: "Alice",
              roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
              accountActive: true,
            },
            ...(enrolled
              ? [
                  {
                    userId: enrolId,
                    userName: "Bob",
                    roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
                    accountActive: true,
                  },
                ]
              : []),
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/classes/c9f15e21-026d-4200-baca-0ba9bd411842/assignments")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === `/api/v1/classes/${scienceId}/assignments`)
      return route.fulfill({
        json: {
          items: [
            {
              assignmentId: "de000000-0000-4000-8000-000000000030",
              title: "Science museum",
              description: "Science",
              instructions: "Explore",
              dueAtUnixSeconds: 1796200000,
              projects: [
                {
                  projectId: "de000000-0000-4000-8000-000000000031",
                  studentId,
                  studentName: "Alice",
                  reviewState: "draft",
                },
              ],
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/assignments")) {
      const data = {
        items: [
          {
            assignmentId,
            sourceProjectId: sourceId,
            title: "Museum",
            organizationName: "School",
            creatorUserName: "mschew",
            description: "Build a museum",
            instructions: "Add exhibits",
            dueAtUnixSeconds: 1796200000,
            projects: [
              {
                projectId: studentProjectId,
                studentId,
                studentName: "Alice",
                approvalStatus: "approved",
                published: true,
                isPublic: true,
              },
              {
                projectId: "de000000-0000-4000-8000-000000000006",
                studentId: "de000000-0000-4000-8000-000000000007",
                studentName: "Bob",
                approvalStatus: "awaiting-approval",
                published: false,
                isPublic: false,
              },
              {
                projectId: "de000000-0000-4000-8000-000000000008",
                studentId: "de000000-0000-4000-8000-000000000009",
                studentName: "Cara",
                approvalStatus: "not-submitted",
                published: false,
                isPublic: false,
              },
              {
                projectId: "de000000-0000-4000-8000-000000000010",
                studentId: "de000000-0000-4000-8000-000000000011",
                studentName: "Dee",
              },
            ],
          },
        ],
        nextCursor: null,
      };
      latestAssignment = { ...data.items[0], revision: 0 };
      data.items = [
        {
          ...latestAssignment,
          projects: latestAssignment.projects.filter((p) => !removedProjects.has(p.projectId)),
        },
      ];
      if (!data.items[0].projects.length) data.items = [];
      return route.fulfill({ json: data });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/home");
  await page.getByRole("heading", { name: "Museum", exact: true }).waitFor();
  const classFilter = page.getByRole("combobox", { name: "Filter projects by class" });
  async function chooseClass(name) {
    await classFilter.click();
    await page.getByRole("option", { name, exact: true }).click();
  }
  await classFilter.click();
  await classFilter.press("End");
  await classFilter.press("Enter");
  assert.equal(await page.getByRole("heading", { name: "Science museum", exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Museum", exact: true }).count(), 0);
  await page.getByRole("tab", { name: /^In Progress/ }).click();
  assert.equal(await page.getByRole("heading", { name: "Science museum", exact: true }).count(), 1);
  await page.getByRole("searchbox", { name: "Search projects" }).fill("Science");
  await chooseClass("History");
  assert.equal(await page.locator(".sp-teacher-card").count(), 0);
  await page.getByRole("tab", { name: /^All Projects/ }).click();
  assert.equal(await page.locator(".sp-teacher-card").count(), 0);
  await page.getByRole("searchbox", { name: "Search projects" }).fill("Museum");
  assert.equal(await page.getByRole("heading", { name: "Museum", exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Science museum", exact: true }).count(), 0);
  await chooseClass("Empty class");
  assert.equal(await page.locator(".sp-teacher-card").count(), 0);
  await chooseClass("All Classes");
  assert.equal(await page.locator(".sp-teacher-card").count(), 2);
  await page.getByRole("searchbox", { name: "Search projects" }).fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await classFilter.click();
  const menu = await page.getByRole("listbox", { name: "Filter projects by class" }).boundingBox();
  assert.ok(menu.x >= 0 && menu.x + menu.width <= 391);
  await classFilter.press("Escape");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: "test-results/facilitator-class-filter-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.screenshot({ path: "test-results/facilitator-class-filter.png", fullPage: true });
  const assignmentCard = page.locator("article").filter({
    has: page.locator(`[id="teacher-project-${classId}:${assignmentId}"]`),
  });
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  assert.equal(new URL(page.url()).searchParams.get("assignmentId"), assignmentId);
  await page.reload();
  await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor();
  await page.getByText("Build a museum", { exact: true }).waitFor();
  assert.equal(await page.getByText("Build a museum", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Add exhibits", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Alice", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "View Project", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "View Progress", exact: true }).count(), 3);
  const student = (name) =>
    page.locator(".sp-teacher-student").filter({ has: page.getByText(name, { exact: true }) });
  assert.equal(
    await student("Alice")
      .locator(".sp-teacher-student-status")
      .getByText("Approved", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Alice")
      .locator(".sp-teacher-student-status")
      .getByText("Public", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Bob")
      .locator(".sp-teacher-student-status")
      .getByText("Not Approved", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Bob")
      .locator(".sp-teacher-student-status")
      .getByText("Private", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Dee")
      .locator(".sp-teacher-student-status p")
      .first()
      .getByText("Unavailable", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await student("Dee")
      .locator(".sp-teacher-student-status p")
      .last()
      .getByText("Unavailable", { exact: true })
      .count(),
    1,
  );

  const historyRequested = page.waitForRequest((req) =>
    new URL(req.url()).pathname.endsWith("/progress-reviews"),
  );
  await student("Alice").getByRole("button", { name: "Reviews", exact: true }).click();
  await historyRequested;
  assert.equal(
    await page.getByRole("dialog", { name: "Reviews", exact: true }).count(),
    0,
    "Reviews waits for its initial content before opening",
  );
  releaseHistory();
  const reviewsDialog = page.getByRole("dialog", { name: "Reviews", exact: true });
  await reviewsDialog.waitFor();
  assert.equal(await reviewsDialog.locator(".sp-progress-entry").count(), 4);
  const initialSize = await reviewsDialog.boundingBox();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const settledSize = await reviewsDialog.boundingBox();
  assert.equal(initialSize.width, settledSize.width);
  assert.equal(initialSize.height, settledSize.height);
  assert.ok(await reviewsDialog.getAttribute("aria-labelledby"));
  await reviewsDialog.getByRole("button", { name: "Add Reviews", exact: true }).click();
  await reviewsDialog.getByRole("textbox", { name: "New review", exact: true }).waitFor();
  assert.equal(
    await reviewsDialog.getByRole("button", { name: "Save Changes", exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await reviewsDialog.getByRole("button", { name: "Cancel", exact: true }).isVisible(),
    true,
  );
  await reviewsDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("tab", { name: "In Progress" }).click();
  assert.equal(await student("Cara").count(), 1);
  assert.equal(await student("Alice").count(), 0);
  assert.equal(await student("Bob").count(), 0);
  assert.equal(await student("Dee").count(), 0);
  await page.getByRole("tab", { name: "Awaiting Approval" }).click();
  assert.equal(await student("Bob").count(), 1);
  assert.equal(await student("Cara").count(), 0);
  assert.equal(await student("Dee").count(), 0);
  await page.getByRole("tab", { name: /All Students/ }).click();
  assert.equal(await page.getByRole("button", { name: "View Project", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "View Progress", exact: true }).count(), 3);
  await page.route("**/?classId=**", (route) => route.fulfill({ body: "Student editor" }));
  moderationAvailable = true;
  await student("Alice").getByRole("button", { name: "View Project", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("projectId") === studentProjectId);
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get("assignmentId"), assignmentId);
  assert.equal(params.get("classId"), classId);
  assert.equal(params.get("studentId"), studentId);
  assert.equal(params.get("review"), "1");
  assert.equal(params.get("view"), "published", "Published View uses the latest-edition reader");
  await page.goto(origin + "/home");
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  await student("Bob").getByRole("button", { name: "View Progress", exact: true }).click();
  await page.waitForURL(
    (url) => url.searchParams.get("projectId") === "de000000-0000-4000-8000-000000000006",
  );
  assert.equal(
    new URL(page.url()).searchParams.get("view"),
    null,
    "Unpublished work keeps its review route",
  );
  assert.equal(new URL(page.url()).searchParams.get("review"), "1");
  await page.goto(origin + "/home");
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  console.log("PASS assignment card shows details and student");
  await page.getByRole("button", { name: "Close project details" }).click();
  assert.equal(
    await page.getByRole("heading", { name: "Standalone", exact: true }).count(),
    1,
    "Unrelated standalone project remains available",
  );
  console.log("PASS unrelated standalone remains visible");
  console.log("PASS progress opens the selected student editor");
  await page.getByRole("heading", { name: "Standalone", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Museum", exact: true }).count(),
    1,
    "An assignment source must not appear as a duplicate standalone project",
  );
  assert.equal(
    await page.getByRole("heading", { name: "Retained class copy", exact: true }).count(),
    0,
  );
  console.log("PASS no duplicate source card");
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Standalone", exact: true }) })
    .getByRole("button", { name: "View Details", exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.get("projectId"), otherId);
  await page.reload();
  await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Standalone", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close project details" }).click();
  assert.equal(new URL(page.url()).search, "");
  await assignmentCard.getByRole("button", { name: "View Details" }).click();
  await page.getByRole("link", { name: "School", exact: true }).click();
  await page.getByRole("heading", { name: "Organisation Details", exact: true }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Workspace", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "New Class", exact: true }).count(), 1);
  await page.getByRole("button", { name: "New Class", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New Class", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Class", exact: true }).click();
  await page.getByRole("option", { name: "History", exact: true }).click();
  await page
    .getByText("Choose existing student accounts from your organisation.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add Bob to class", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Add Student to Class", exact: true })
    .getByRole("button", { name: "Add to Class", exact: true })
    .click();
  await page.getByRole("rowheader", { name: "@Bob", exact: true }).waitFor();
  assert.equal(enrolled, true);
  assert.equal(await page.getByRole("heading", { name: "Add Students", exact: true }).count(), 0);
  await page
    .getByText("Your administrator creates accounts for new students.", { exact: true })
    .waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "Museum" })
    .getByRole("button", { name: "View Details", exact: true })
    .click();
  await page.waitForURL(
    (url) => url.pathname === "/home" && url.searchParams.get("assignmentId") === assignmentId,
  );
  await page.getByRole("link", { name: "School", exact: true }).click();
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/home" && url.searchParams.get("assignmentId") === assignmentId,
  );

  moderationAvailable = true;
  await page.reload();
  const listBeforeSelection = await page.locator(".sp-teacher-student-list").boundingBox();
  await page.getByRole("button", { name: "Select student projects" }).click();
  const listDuringSelection = await page.locator(".sp-teacher-student-list").boundingBox();
  assert.equal(
    listDuringSelection.y,
    listBeforeSelection.y,
    "Selection mode keeps the list in place",
  );
  assert.equal(
    listDuringSelection.height,
    listBeforeSelection.height,
    "Selection mode keeps the list height",
  );
  await page.getByRole("checkbox", { name: "Select all visible projects" }).check();
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 5);
  await page
    .getByRole("group", { name: "Student project selection" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(moderationWrites.length, 0);
  await page.getByRole("button", { name: "Select student projects" }).click();
  await page.getByRole("checkbox", { name: "Select Alice's project", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select Bob's project", exact: true }).check();
  await page
    .getByRole("group", { name: "Student project selection" })
    .getByRole("button", { name: "Delete selected (2)", exact: true })
    .click();
  let confirmation = page.getByRole("dialog", { name: "Delete Selected Projects?" });
  await confirmation.waitFor();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(moderationWrites.length, 0, "Cancelling selected deletion sends no writes");
  await page
    .getByRole("group", { name: "Student project selection" })
    .getByRole("button", { name: "Delete selected (2)", exact: true })
    .click();
  confirmation = page.getByRole("dialog", { name: "Delete Selected Projects?" });
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Select student projects" }).waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".sp-teacher-student strong")].some(
        (n) => n.textContent === "Cara",
      ) && !document.querySelector(".sp-teacher-project-selection"),
  );
  assert.deepEqual(moderationWrites, [
    { id: studentProjectId, action: "delete" },
    { id: "de000000-0000-4000-8000-000000000006", action: "delete" },
  ]);
  assert.equal(await student("Alice").count(), 0);
  assert.equal(await student("Bob").count(), 0);
  assert.equal(await student("Cara").count(), 1);
  assert.equal(await student("Dee").count(), 1);
  await student("Cara").getByRole("button", { name: "Hide", exact: true }).click();
  confirmation = page.getByRole("dialog", { name: "Hide Student Project?" });
  await confirmation.screenshot({ path: "test-results/facilitator-hide-dialog.png" });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(moderationWrites.length, 2);
  await page.getByRole("button", { name: "Edit Due Date" }).click();
  await page.getByLabel(/^Due date/).focus();
  await page
    .locator(".sp-teacher-info")
    .screenshot({ path: "test-results/facilitator-due-date-focus.png" });
  await page
    .locator(".sp-assignment-inline")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.screenshot({ path: "test-results/facilitator-published-projects.png" });
  console.log(
    "PASS selected-project deletion, cancellation, scoped writes and authoritative refresh",
  );

  await page.getByRole("button", { name: "Select student projects" }).click();
  const selection = page.getByRole("group", { name: "Student project selection" });
  await page.getByRole("checkbox", { name: "Select all visible projects" }).check();
  holdRosterRefresh = true;
  await selection.getByRole("button", { name: "Hide selected (2)", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Hide Selected Projects?" })
    .getByRole("button", { name: "Hide", exact: true })
    .click();
  await rosterRefreshStarted;
  const pendingHide = page.getByRole("dialog", { name: "Hide Selected Projects?" });
  await pendingHide.getByRole("button", { name: "Updating…", exact: true }).waitFor();
  assert.ok(await pendingHide.getByRole("button", { name: "Updating…", exact: true }).isDisabled());
  assert.ok(
    await pendingHide.isVisible(),
    "Confirmation stays open during authoritative roster refresh",
  );
  holdRosterRefresh = false;
  releaseRosterRefresh();
  await selection.getByRole("button", { name: "Show selected (2)", exact: true }).waitFor();
  assert.equal(moderationWrites.filter((w) => w.action === "hide").length, 2);
  assert.ok(await student("Cara").getByRole("button", { name: "Show", exact: true }).count());
  await selection.getByRole("button", { name: "Show selected (2)", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Show Selected Projects?" })
    .getByRole("button", { name: "Show", exact: true })
    .click();
  await selection.getByRole("button", { name: "Hide selected (2)", exact: true }).waitFor();
  assert.equal(moderationWrites.filter((w) => w.action === "show").length, 2);
  await selection.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(
    bulkModerationRequests.map((request) => ({
      action: request.action,
      count: request.projectIds.length,
    })),
    [
      { action: "delete", count: 2 },
      { action: "hide", count: 2 },
      { action: "show", count: 2 },
    ],
    "Each selected action sends one bulk mutation",
  );
  console.log("PASS selected Hide and Show refresh row states without clearing selection");
  console.log(
    "PASS organisation context, class enrolment, existing-account hint, project navigation and close return",
  );
} finally {
  await browser?.close();
  await server.close();
}
