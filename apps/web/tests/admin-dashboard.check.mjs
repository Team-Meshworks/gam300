import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const server = process.argv[2]
  ? null
  : await createServer({
      cacheDir: "test-results/vite-admin-dashboard",
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [resolve("../.."), realpathSync("node_modules")] },
      },
      logLevel: "error",
    });
await server?.listen();
const origin = process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser({ target: origin });
const screenshot = process.env.CHECK_SCREENSHOT ?? "../../.artifacts/admin-dashboard/desktop.png";
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const newSchool = {
  id: "a6195776-48eb-49ab-832c-776bdca05d31",
  name: "New School",
  isActive: true,
  projectCount: 0,
  facilitatorCount: 0,
  creatorCount: 0,
};
const projects = [
  "The Silk Road: A Journey Through History",
  "Life in Ancient Rome",
  "World War II: A Global Conflict",
  "Ancient China",
].map((title, index) => ({
  projectId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  title,
  revision: 0,
  updatedAt: "2026-11-03T00:00:00Z",
  archived: false,
  organizationName: "Ridgeview Secondary School",
  isPublic: index === 1 || index === 2,
  permissions: { canEdit: true, canManage: true, canPublish: false },
}));
const archivedProject = {
  ...projects[0],
  projectId: "00000000-0000-4000-8000-000000000099",
  title: "Archived Project",
  archived: true,
  isPublic: false,
};
const publicationStates = Object.fromEntries(
  [...projects, archivedProject].map((project) => [
    project.projectId,
    {
      projectId: project.projectId,
      publicationCount: 1,
      hiddenCount: 0,
      publicCount: project.isPublic ? 1 : 0,
    },
  ]),
);
const originallyPublic = new Set(
  projects.filter((project) => project.isPublic).map((project) => project.projectId),
);
const moderationReads = [];
const moderationWrites = [];
let loseModerationResponse = false;
let failModerationRead = true;
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1212 },
  });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let authenticated = false;
  let role = "Administrator";
  let forced = false;
  let rejectLogin = false;
  let projectError = false;
  let assetError = false;
  let assetReads = 0;
  let projectReads = 0;
  let adminProjectReads = 0;
  let creations = 0;
  let loseCreationReply = false;
  const creationReply = Promise.withResolvers();
  // Keep mock catalogue previews independent of Vite source paths and build hashing.
  const assetThumbnail = await readFile("editor/home/assets/default-project-neutral.jpg");
  await page.route("**/test-fixtures/admin-asset-thumbnail.jpg", (route) =>
    route.fulfill({ body: assetThumbnail, contentType: "image/jpeg" }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/auth/session")
      return authenticated
        ? route.fulfill({
            json: {
              userId,
              displayName: "VThere",
              role,
              orgId: role === "Administrator" ? null : orgId,
              mustChangePassword: forced,
            },
          })
        : route.fulfill({ status: 401 });
    if (url.pathname === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "csrf" } });
    if (request.method() === "POST") {
      assert.equal(request.headers()["x-csrf-token"], "csrf");
      if (url.pathname === "/api/v1/auth/login") {
        if (rejectLogin) return route.fulfill({ status: 401 });
        authenticated = true;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/v1/auth/password") {
        forced = false;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/v1/auth/logout") {
        assert.equal(request.headers()["x-spatia-account"], userId);
        authenticated = false;
        return route.fulfill({ status: 204 });
      }
      if (
        /^\/api\/v1\/admin\/projects(?:\/[0-9a-f-]+)?\/publication-moderation$/.test(url.pathname)
      ) {
        assert.equal(request.headers()["x-spatia-account"], userId);
        const { action, projectIds = [url.pathname.split("/")[5]] } = request.postDataJSON();
        for (const projectId of projectIds) {
          moderationWrites.push({ projectId, action });
          const state = publicationStates[projectId];
          if (action === "delete") {
            state.publicationCount = 0;
            state.hiddenCount = 0;
            state.publicCount = 0;
          } else {
            state.hiddenCount = action === "hide" ? state.publicationCount : 0;
            state.publicCount =
              action === "hide" || !originallyPublic.has(projectId) ? 0 : state.publicationCount;
          }
          const project = projects.find((row) => row.projectId === projectId);
          if (project) {
            project.isPublic = state.publicCount > 0;
          }
        }
        if (loseModerationResponse) {
          loseModerationResponse = false;
          return route.abort("failed");
        }
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/v1/admin/organizations") {
        assert.equal(request.headers()["x-spatia-account"], userId);
        assert.deepEqual(request.postDataJSON(), {
          name: loseCreationReply ? "Unconfirmed School" : "New School",
        });
        creations++;
        if (loseCreationReply) return route.abort("failed");
        await creationReply.promise;
        return route.fulfill({
          status: 201,
          json: newSchool,
        });
      }
    }
    if (url.pathname === "/api/v1/admin/projects/publication-moderation") {
      assert.equal(request.headers()["x-spatia-account"], userId);
      const ids = url.searchParams.get("ids").split(",");
      moderationReads.push(ids);
      if (failModerationRead) {
        failModerationRead = false;
        return route.fulfill({ status: 503 });
      }
      return route.fulfill({
        json: { items: ids.map((id) => publicationStates[id]) },
      });
    }
    if (url.pathname === "/api/v1/admin/assets") {
      assetReads++;
      assert.equal(request.headers()["x-spatia-account"], userId);
      if (assetError) return route.fulfill({ status: 503 });
      return route.fulfill({
        json: {
          assets: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Approved Gallery",
              kind: "environment",
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Approved Sculpture",
              kind: "model",
            },
          ].map((asset) => ({
            ...asset,
            category: asset.kind === "model" ? "Objects" : null,
            status: "approved",
            hidden: false,
            deleted: false,
            removedFromProjects: false,
            thumbnail: "/test-fixtures/admin-asset-thumbnail.jpg",
            validation: [],
            actions: ["hide", "delete"],
          })),
          policy: {
            extensions: [".glb"],
            maxBytes: 20971520,
            categories: { environment: null, model: ["Objects"] },
            canSubmit: true,
            canForceRemove: false,
          },
        },
      });
    }
    if (url.pathname === "/api/v1/projects") {
      projectReads++;
      if (request.headers()["referer"]?.includes("/admin/dashboard")) adminProjectReads++;
      if (new URL(request.headers().referer).pathname === "/admin/dashboard")
        assert.equal(request.headers()["x-spatia-account"], userId);
      if (projectError) return route.fulfill({ status: 503 });
      if (url.searchParams.get("archived") === "true")
        return route.fulfill({
          json: {
            items: [archivedProject],
            nextCursor: null,
          },
        });
      const cursor = url.searchParams.get("cursor");
      const items = cursor
        ? projects.slice(2)
        : projects.slice(0, url.searchParams.get("limit") === "3" ? 3 : 2);
      return route.fulfill({
        json: { items, nextCursor: cursor ? null : items.at(-1).projectId },
      });
    }
    if (/^\/api\/v1\/classes\/[0-9a-f-]+\/assignments\/[0-9a-f-]+$/.test(url.pathname)) {
      assert.equal(request.headers()["x-spatia-account"], userId);
      const assignmentId = url.pathname.split("/").at(-1);
      return route.fulfill({
        json: {
          assignmentId,
          title: assignmentId === userId ? "Rome" : "Rome Extension",
          description: "Create a virtual museum exploring ancient Rome.",
          instructions: "Build three exhibits with historical context.",
          dueAtUnixSeconds: 2000000000,
          sourceProjectId: projects[1].projectId,
          organizationName: "Ridgeview Secondary School",
          creatorName: "Ms Tan",
          creatorUserName: "MsTan",
          projects: [
            {
              studentId: userId,
              projectId: projects[2].projectId,
              studentName: "Aisyah (aisyah)",
              studentUserName: "progress.student1",
              approvalStatus: "approved",
              isPublic: true,
              published: true,
            },
            {
              studentId: orgId,
              projectId: projects[3].projectId,
              studentName: "Christopher Low (christopher)",
              approvalStatus: "awaiting-approval",
              isPublic: false,
              published: true,
            },
          ],
        },
      });
    }
    if (/^\/api\/v1\/projects\/[0-9a-f-]+\/assignments$/.test(url.pathname)) {
      assert.equal(request.headers()["x-spatia-account"], userId);
      return route.fulfill({
        json: {
          projectId: url.pathname.split("/")[4],
          organizationId: orgId,
          classAssignments:
            url.pathname.split("/")[4] === projects[1].projectId
              ? [
                  { classId: userId, className: "4A", assignmentId: userId },
                  { classId: orgId, className: "4B", assignmentId: orgId },
                ]
              : [],
        },
      });
    }
    if (url.pathname === `/api/v1/admin/organizations/${newSchool.id}/bulk-imports`)
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (
      url.pathname === `/api/v1/admin/organizations/${newSchool.id}/projects` ||
      (url.pathname === "/api/v1/admin/users" && url.searchParams.get("orgId") === newSchool.id)
    )
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.pathname === "/api/v1/admin/organizations")
      return route.fulfill({
        json: {
          items: [
            ...(creations > 0 ? [newSchool] : []),
            {
              id: orgId,
              name: "Ridgeview Secondary School",
              isActive: true,
              projectCount: 0,
              facilitatorCount: 0,
              creatorCount: 0,
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({ status: 404 });
  });
  async function signIn() {
    await page.goto(origin + "/login");
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await page.getByLabel("Password", { exact: true }).fill("Synthetic-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
  }
  // Credentials are verified before routing, and a required password change takes priority.
  rejectLogin = true;
  await signIn();
  await page.getByRole("alert").filter({ hasText: "could not be accepted" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(projectReads, 0);
  rejectLogin = false;
  forced = true;
  await signIn();
  await page.getByRole("heading", { name: "Change your password." }).waitFor();
  assert.equal(projectReads, 0);
  await page.getByLabel("Current password", { exact: true }).fill("Synthetic-password1!");
  await page.getByLabel("New password", { exact: true }).fill("Replacement-password2!");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Replacement-password2!");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  await page.getByRole("heading", { name: "Welcome Back, VThere", exact: true }).waitFor();
  const circleOpacity = () =>
    page
      .locator(".sp-shell > .sp-wash")
      .evaluateAll((circles) => circles.map((circle) => getComputedStyle(circle).opacity));
  const dashboardOpacity = await circleOpacity();
  assert.deepEqual(dashboardOpacity, ["0.65", "0.65"]);
  assert.equal(
    await page.getByRole("link", { name: "+ Add Environment", exact: true }).getAttribute("href"),
    "/spaces?add=1",
  );
  assert.equal(
    await page.getByRole("link", { name: "+ Add Item", exact: true }).getAttribute("href"),
    "/assets?add=1",
  );
  await page.evaluate(() => {
    window.organisationNavigationMarker = "same-workspace";
  });
  await page.getByRole("link", { name: "View Organisations", exact: true }).click();
  await page.waitForURL(origin + "/organisations");
  assert.equal(
    await page.evaluate(() => window.organisationNavigationMarker),
    "same-workspace",
    "Opening organisations preserves the document instead of flashing a new page",
  );
  await page.goBack();
  await page.getByRole("link", { name: "View Organisations", exact: true }).waitFor();
  await page.goForward();
  await page.getByRole("heading", { name: "All Organisations", exact: true, level: 1 }).waitFor();
  assert.deepEqual(await circleOpacity(), dashboardOpacity);
  assert.equal(await page.evaluate(() => window.organisationNavigationMarker), "same-workspace");
  await page.getByRole("link", { name: "Close organisations" }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  for (const [link, heading] of [
    ["View Environments", "All 3D Spaces"],
    ["View Library", "All Assets"],
  ]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.deepEqual(await circleOpacity(), dashboardOpacity);
    assert.equal(
      await page.evaluate(() => window.organisationNavigationMarker),
      "same-workspace",
      `${link} preserves the workspace document`,
    );
    await page.getByRole("button", { name: "Close asset administration", exact: true }).click();
    await page.getByRole("link", { name: "View Organisations", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.organisationNavigationMarker),
      "same-workspace",
      "Closing the catalogue preserves the workspace document",
    );
  }

  await page
    .getByRole("button", {
      name: `View Details for ${projects[0].title}`,
      exact: true,
    })
    .waitFor();
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  const chromeGeometry = () =>
    page
      .locator(
        ".sp-account-header .sp-header-brand, .sp-account-header .sp-avatar, .sp-account-header .sp-header-logout",
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y + scrollY,
            width: rect.width,
            height: rect.height,
          };
        }),
      );
  const chromeBefore = await chromeGeometry();
  const catalogueChrome = chromeBefore.map((rect) => ({ ...rect, x: rect.x + 3, y: rect.y - 15 }));
  assert.equal(chromeBefore[1].height, 32);
  assert.equal(chromeBefore[2].height, chromeBefore[1].height);
  const entryIcons = await page.locator(".admin-entry-symbol > svg").evaluateAll((nodes) =>
    nodes.map((node) => ({
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    })),
  );
  assert.deepEqual(
    entryIcons,
    Array.from({ length: 3 }, () => ({ width: 24, height: 24 })),
  );
  await page.getByRole("button", { name: "View All", exact: true }).click();
  const projectView = page.locator('section[aria-label="All Published Projects"]');
  await projectView.waitFor();
  const headingTops = await projectView
    .locator(".admin-project-view-heading")
    .evaluate((row) =>
      [...row.querySelectorAll("h1, :scope > .sp-search, :scope > .sp-close-button")].map(
        (node) => node.getBoundingClientRect().top,
      ),
    );
  assert.ok(
    Math.abs(headingTops[1] - headingTops[0] - 2) <= 1 &&
      Math.abs(headingTops[1] - headingTops[2]) <= 1,
    "Search and close share the Figma heading offset",
  );
  assert.equal(
    await projectView.locator(".admin-project-loading [inert]").count(),
    0,
    "Opening the list keeps already loaded cards visible without a placeholder flash",
  );
  assert.equal(new URL(page.url()).searchParams.get("view"), "projects");
  const sessionRequest = "**/api/v1/auth/session";
  const sessionGate = Promise.withResolvers();
  await page.route(sessionRequest, async (route) => {
    await sessionGate.promise;
    await route.fallback();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.locator('.admin-project-browser[aria-busy="true"]').waitFor();
    assert.equal(await page.locator(".admin-greeting, .sp-workspace-loading").count(), 0);
  } finally {
    sessionGate.resolve();
  }
  await projectView.waitFor();
  await page.unroute(sessionRequest);
  assert.equal(
    await page.getByRole("heading", { name: "All Published Projects", exact: true }).isVisible(),
    true,
  );
  assert.deepEqual(
    await chromeGeometry(),
    catalogueChrome,
    "Opening all projects preserves header geometry",
  );
  await page.screenshot({
    path: join(dirname(screenshot), "admin-projects-after.png"),
    fullPage: true,
  });
  for (const name of [
    /^All Published(?: \(\d+\))?$/,
    /^Private(?: \(\d+\))?$/,
    /^Public(?: \(\d+\))?$/,
  ]) {
    assert.equal(await projectView.getByRole("tab", { name, exact: true }).isVisible(), true);
  }
  assert.equal(await projectView.getByRole("tab", { name: /^Archived/ }).count(), 0);
  assert.equal(await projectView.getByRole("link", { name: "Open project workspace" }).count(), 0);
  await projectView.getByRole("tab", { name: "All Published (4)", exact: true }).waitFor();
  assert.equal(
    await projectView
      .getByText("Review published experiences and control what visitors can explore.", {
        exact: true,
      })
      .isVisible(),
    true,
  );
  const cardContrast = await projectView
    .locator(".admin-project-card button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const style = getComputedStyle(button);
        const luminance = (color) => {
          const rgb = color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const ink = luminance(style.color),
          surface = luminance(style.backgroundColor);
        return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
      }),
    );
  assert.equal(
    cardContrast.every((ratio) => ratio >= 4.5),
    true,
    "Project card actions remain readable against their button fills",
  );
  const filterReads = projectReads;
  await projectView.getByRole("tab", { name: "Public (2)", exact: true }).click();
  assert.equal(await projectView.locator(".admin-project-card").count(), 2);
  assert.deepEqual(await projectView.locator(".admin-project-status").allTextContents(), [
    "Public",
    "Public",
  ]);
  assert.equal(await projectView.getByRole("button", { name: /^View Details for/ }).count(), 2);
  assert.equal(
    await projectView.locator(".admin-project-organization").first().textContent(),
    "Ridgeview Secondary School",
  );
  await projectView.getByRole("tab", { name: "Private (2)", exact: true }).click();
  assert.equal(await projectView.locator(".admin-project-card").count(), 2);
  assert.deepEqual(await projectView.locator(".admin-project-status").allTextContents(), [
    "Private",
    "Private",
  ]);
  assert.equal(
    projectReads,
    filterReads,
    "Visibility filters use the complete loaded page set without refetching",
  );
  assert.deepEqual(
    await chromeGeometry(),
    catalogueChrome,
    "Visibility filtering preserves header geometry",
  );
  await projectView.getByRole("tab", { name: /^All Published(?: \(\d+\))?$/ }).click();
  await projectView
    .getByRole("button", {
      name: "View Details for Ancient China",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await projectView.getByRole("tab", { name: "All Published (4)", exact: true }).count(),
    1,
  );
  await projectView.getByLabel("Search published projects").fill("Rome");
  assert.equal(await projectView.locator(".admin-project-card").count(), 1);
  const readsBefore = projectReads;
  await projectView
    .getByRole("button", {
      name: "View Details for Life in Ancient Rome",
      exact: true,
    })
    .click();
  const details = page.getByRole("region", {
    name: "Project details",
    exact: true,
  });
  await details.waitFor();
  assert.equal(await details.getByText("Life in Ancient Rome", { exact: true }).isVisible(), true);
  assert.equal(await details.locator(".admin-project-visibility").textContent(), "Public");
  await details.getByRole("link", { name: "Ridgeview Secondary School", exact: true }).waitFor();
  assert.equal(
    await details.getByRole("button", { name: "Manage Access", exact: true }).count(),
    0,
  );
  assert.deepEqual(
    await chromeGeometry(),
    catalogueChrome,
    "Project details preserves header geometry",
  );
  await details
    .getByText("Create a virtual museum exploring ancient Rome.", {
      exact: true,
    })
    .waitFor();
  const progress = details.getByRole("region", { name: "Published student projects" });
  assert.equal(await progress.locator(".admin-progress-row").count(), 2);
  assert.equal(await progress.getByText("Approval Status", { exact: true }).count(), 0);
  assert.equal(await progress.getByRole("button", { name: "Review", exact: true }).count(), 0);
  await details
    .locator(".admin-project-moderation")
    .getByRole("button", { name: "Hide", exact: true })
    .waitFor({ state: "visible" });
  await details.getByRole("alert").filter({ hasText: "request could not be completed" }).waitFor();
  assert.equal(
    await details
      .locator(".admin-project-moderation")
      .getByRole("button", { name: "Hide", exact: true })
      .isDisabled(),
    true,
  );
  await details.getByRole("button", { name: "Retry Publication Visibility", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector(".admin-project-moderation button")?.disabled,
  );
  assert.deepEqual(
    moderationReads.at(-1),
    [projects[1].projectId, projects[2].projectId, projects[3].projectId],
    "Parent loads main and student publication metadata together",
  );
  const privateStudent = progress
    .locator(".admin-progress-row")
    .filter({ hasText: "Christopher Low" });
  assert.equal(
    await privateStudent.getByRole("button", { name: "Hide", exact: true }).isDisabled(),
    false,
  );

  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.screenshot({
    path: join(dirname(screenshot), "admin-project-details-native.png"),
    fullPage: true,
  });
  assert.equal(
    await progress.evaluate((panel) => getComputedStyle(panel).backgroundColor),
    "rgb(255, 253, 251)",
  );
  await progress.getByRole("tab", { name: "Private (1)" }).click();
  assert.equal(await progress.locator(".admin-progress-row").count(), 1);
  assert.equal(await progress.getByText("Christopher Low", { exact: true }).isVisible(), true);
  await progress.getByRole("tab", { name: "All Published (2)" }).click();
  await progress.getByLabel("Search students").fill("@progress.student1");
  assert.equal(await progress.locator(".admin-progress-row").count(), 1);
  await progress.getByLabel("Search students").fill("aisyah");
  assert.equal(await progress.locator(".admin-progress-row").count(), 1);
  assert.equal(
    await progress.getByRole("link", { name: "View Project", exact: true }).getAttribute("href"),
    `/?projectId=${projects[2].projectId}&view=published&returnProjectId=${projects[1].projectId}&returnView=projects`,
  );
  assert.equal(await details.getByText("@MsTan", { exact: true }).count(), 1);
  assert.equal(
    await details
      .getByText("Create a virtual museum exploring ancient Rome.", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await details
      .getByText("Build three exhibits with historical context.", { exact: true })
      .count(),
    1,
  );
  const classAssignment = details.getByRole("combobox", { name: "Class Assignment", exact: true });
  await classAssignment.click();
  await page.getByRole("option", { name: /^4B/ }).click();
  assert.ok((await classAssignment.innerText()).startsWith("4B"));
  assert.equal(
    await details.locator(".admin-project-metadata dd").filter({ hasText: "4B" }).count(),
    1,
  );
  await classAssignment.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  assert.ok((await classAssignment.innerText()).startsWith("4A"));

  assert.deepEqual(
    await details.locator(".sp-close-button").evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const icon = button.querySelector("svg").getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        x: icon.x + icon.width / 2 - rect.x - rect.width / 2,
        y: icon.y + icon.height / 2 - rect.y - rect.height / 2,
      };
    }),
    { width: 36, height: 36, x: 0, y: 0 },
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({
    path: join(dirname(screenshot), "admin-project-details-after.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 911 });
  await page.screenshot({
    path: join(dirname(screenshot), "admin-project-details-reference.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(dirname(screenshot), "admin-project-details-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "Student progress fits mobile without horizontal page scroll",
  );
  await page.setViewportSize({ width: 1440, height: 1212 });

  const rosterBeforeSelection = await progress.locator(".admin-progress-list").boundingBox();
  await progress.getByRole("button", { name: "Select projects", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(
    await progress.locator(".admin-progress-list").boundingBox(),
    rosterBeforeSelection,
    "Selection preserves the roster position and height",
  );
  assert.ok(await progress.locator(".admin-student-actions button").first().isDisabled());
  assert.ok(await progress.getByRole("tab", { name: /^All Published/ }).isVisible());
  const selection = progress.getByRole("group", { name: "Project selection", exact: true });
  assert.equal(
    await selection.getByRole("button", { name: "Hide selected", exact: true }).isDisabled(),
    true,
  );
  await selection.getByRole("button", { name: "Select all", exact: true }).click();
  assert.equal(await progress.getByRole("link", { name: "View Project", exact: true }).count(), 0);
  assert.ok(await progress.locator(".admin-student-actions button").first().isDisabled());
  const selectedCount = await progress
    .getByRole("checkbox", { name: /^Select project by / })
    .count();
  await selection
    .getByRole("status")
    .filter({ hasText: `${selectedCount} selected` })
    .waitFor();
  await selection.getByRole("button", { name: "Hide selected", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Hide Selected Projects?", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await selection.getByRole("button", { name: "Hide selected", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await selection.getByRole("button", { name: "Select all", exact: true }).click();
  await selection.getByRole("button", { name: "Show selected", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await progress.getByRole("button", { name: "Cancel selection", exact: true }).click();
  const mainModeration = details.locator(".admin-project-moderation");
  const writesBeforeModeration = moderationWrites.length;
  await mainModeration.getByRole("button", { name: "Hide", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Hide Publications?", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(
    moderationWrites.length,
    writesBeforeModeration,
    "Cancelling moderation does not mutate publications",
  );
  await mainModeration.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await details.locator(".admin-project-visibility").textContent(), "Private");
  await mainModeration.getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await details.locator(".admin-project-visibility").textContent(), "Public");
  await mainModeration.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete Publications?", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  const studentRow = progress.locator(".admin-progress-row").filter({ hasText: "Aisyah" });
  loseModerationResponse = true;
  await studentRow.getByRole("button", { name: "Hide", exact: true }).click();
  const uncertainDialog = page.getByRole("dialog", {
    name: "Hide Publications?",
    exact: true,
  });
  await uncertainDialog.getByRole("button", { name: "Hide", exact: true }).click();
  await uncertainDialog
    .getByRole("alert")
    .filter({ hasText: "result could not be confirmed" })
    .waitFor();
  assert.equal(
    await uncertainDialog.getByRole("button", { name: "Hide", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    moderationWrites.length,
    writesBeforeModeration + 3,
    "An unknown write result is not automatically retried",
  );
  await uncertainDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await studentRow.getByRole("button", { name: "Hide", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Show Publications?", exact: true })
    .getByRole("button", { name: "Show", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await progress.getByRole("button", { name: "Select projects", exact: true }).click();
  await progress.getByRole("checkbox", { name: "Select project by Aisyah", exact: true }).check();
  await selection.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete Selected Projects?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    await studentRow.count(),
    0,
    "Deleted publications disappear from the published roster",
  );
  await progress.getByRole("button", { name: "Select projects", exact: true }).waitFor();
  assert.equal(
    await progress.getByRole("button", { name: "Cancel selection", exact: true }).count(),
    0,
    "Successful bulk deletion exits selection mode",
  );
  await progress.getByLabel("Search students").fill("");
  assert.equal(await progress.locator(".admin-progress-row").count(), 1);
  const remainingProject = progress.locator(".admin-progress-row").first();
  assert.equal(
    await remainingProject.getByRole("button", { name: "Hide", exact: true }).isDisabled(),
    false,
  );
  assert.equal(
    await remainingProject.getByRole("button", { name: "Delete", exact: true }).isDisabled(),
    false,
  );

  assert.equal(
    projectReads,
    readsBefore,
    "Moderation updates cached project state without reloading project pages",
  );
  await details.getByRole("button", { name: "Back", exact: true }).click();
  await details.waitFor({ state: "detached" });
  assert.equal(await projectView.isVisible(), true, "Back returns to the project list");
  assert.equal(await projectView.getByLabel("Search published projects").inputValue(), "Rome");
  assert.equal(await projectView.getByRole("tab", { name: "Public (1)", exact: true }).count(), 1);
  assert.equal(await projectView.getByRole("tab", { name: "Private (2)", exact: true }).count(), 1);

  await projectView.getByLabel("Search published projects").fill("Silk Road");
  await projectView
    .getByRole("button", {
      name: `View Details for ${projects[0].title}`,
      exact: true,
    })
    .click();
  await page
    .getByText("No published student projects are linked to this project.", {
      exact: true,
    })
    .waitFor();
  const unassigned = page.getByRole("region", { name: "Project details", exact: true });
  assert.equal(await unassigned.getByText("Created by", { exact: true }).count(), 1);
  assert.equal(await unassigned.getByText("No class assigned", { exact: true }).count(), 1);
  assert.equal(
    await unassigned.getByRole("heading", { name: "Project Description", exact: true }).count(),
    1,
  );
  assert.equal(
    await unassigned.getByRole("heading", { name: "Project Instructions", exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: join(dirname(screenshot), "admin-project-unassigned.png"),
    fullPage: true,
  });
  await page
    .getByRole("region", { name: "Project details", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();

  assert.equal(projectReads, readsBefore, "Returning to the list does not reload its pages");
  await projectView.getByLabel("Search published projects").fill("");
  assert.equal(
    await projectView.locator(".admin-project-card").count(),
    3,
    "Loaded published projects are retained while deleted editions are removed",
  );
  await projectView.getByLabel("Search published projects").fill("no matching project");
  await projectView.getByRole("status").filter({ hasText: "No matching projects" }).waitFor();
  assert.equal(
    await projectView.locator(".admin-project-loading").count(),
    0,
    "An empty result has no reserved loading-card area",
  );
  await projectView.getByRole("button", { name: "Back", exact: true }).click();
  await projectView.waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("heading", { name: "Welcome Back, VThere", exact: true }).isVisible(),
    true,
  );
  assert.deepEqual(
    await page.locator(".admin-project-status").allTextContents(),
    ["Private", "Public"],
    "Home cards receive student publication changes from the cached project list",
  );
  const overflowBefore = await page.evaluate(() => getComputedStyle(document.body).overflowY);
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Add Organisation",
    exact: true,
  });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), "hidden");
  assert.deepEqual(
    await chromeGeometry(),
    chromeBefore,
    "Opening a dialog preserves header geometry",
  );
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).overflowY),
    overflowBefore,
  );
  assert.deepEqual(
    await chromeGeometry(),
    chromeBefore,
    "Closing a dialog restores header geometry",
  );
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add Organisation", exact: true });
  await dialog.getByLabel("Organisation name").fill(" New School ");
  await dialog.getByRole("button", { name: "Create", exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  const creating = dialog.getByRole("button", { name: "Creating…", exact: true });
  await creating.waitFor();
  assert.equal(await creating.isDisabled(), true);
  creationReply.resolve();
  await dialog.waitFor({ state: "detached" });
  assert.equal(creations, 1);
  await page.waitForURL(origin + "/organisations?organisation=" + newSchool.id);
  await page.getByRole("heading", { name: newSchool.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Accounts", exact: false }).first().waitFor();
  await page.screenshot({
    path: join(dirname(screenshot), "created-organisation.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.getByRole("heading", { name: "All Organisations", level: 1, exact: true }).waitFor();
  assert.deepEqual(
    await chromeGeometry(),
    catalogueChrome,
    "The organisation directory preserves header geometry",
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({
    path: join(dirname(screenshot), "admin-organisations-after.png"),
    fullPage: true,
  });
  await page.getByLabel("Search organisations").fill("Ridgeview");
  await page
    .getByRole("button", {
      name: "Open Ridgeview Secondary School",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  assert.equal(await page.getByLabel("Search organisations").inputValue(), "Ridgeview");
  await page.getByRole("link", { name: "Close organisations", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  loseCreationReply = true;
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add Organisation", exact: true });
  await dialog.getByLabel("Organisation name").fill("Unconfirmed School");
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await create.click();
  await dialog.getByRole("alert").filter({ hasText: "Unconfirmed School" }).waitFor();
  await dialog.getByRole("button", { name: "Check organisation directory" }).waitFor();
  assert.equal(await create.count(), 0, "An uncertain creation must offer directory recovery");
  assert.equal(creations, 2, "Losing the receipt must not allow a second creation");
  await page.reload();
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add Organisation", exact: true });
  await dialog.getByRole("alert").filter({ hasText: "Unconfirmed School" }).waitFor();
  await dialog.getByRole("button", { name: "Check organisation directory" }).click();
  await page.getByRole("heading", { name: "All Organisations", level: 1, exact: true }).waitFor();
  await page.getByRole("link", { name: "Close organisations", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add Organisation", exact: true });
  await dialog.getByRole("button", { name: "I checked the directory" }).click();
  await dialog.getByLabel("Organisation name").fill("Different School");
  assert.equal(await dialog.getByRole("button", { name: "Create" }).isEnabled(), true);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  loseCreationReply = false;
  for (const [button, path, title, expected, excluded, noun] of [
    [
      "View Environments",
      "/spaces",
      "All 3D Spaces",
      "Approved Gallery",
      "Approved Sculpture",
      "3D spaces",
    ],
    ["View Library", "/assets", "All Assets", "Approved Sculpture", "Approved Gallery", "assets"],
  ]) {
    const readsBeforeOpen = assetReads;
    await page.getByRole("link", { name: button, exact: true }).click();
    await page.waitForURL(origin + path);
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    const library = page.locator(".asset-admin");
    await library.getByText(expected, { exact: true }).waitFor();
    const preview = library
      .locator("article")
      .filter({ hasText: expected })
      .locator(".asset-admin-thumbnail img");
    await preview.evaluate((image) => image.decode());
    assert.equal(await preview.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    assert.equal(await library.getByText(excluded, { exact: true }).count(), 0);
    assert.ok(
      assetReads > readsBeforeOpen,
      "Opening asset administration reads assets from the API",
    );
    await library.getByRole("searchbox", { name: `Search ${noun}` }).fill("no matching asset");
    await library.getByRole("heading", { name: `No matching ${noun}` }).waitFor();
    await page.getByRole("button", { name: "Close asset administration" }).click();
    await page.waitForURL(origin + "/admin/dashboard");
  }
  assetError = true;
  await page.getByRole("link", { name: "View Environments", exact: true }).click();
  await page.waitForURL(origin + "/spaces");
  const failedLibrary = page.locator(".asset-admin");
  await failedLibrary.getByRole("alert").waitFor();
  assert.equal(await failedLibrary.getByText("Approved Gallery", { exact: true }).count(), 0);
  await failedLibrary.getByRole("button", { name: "Close asset administration" }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  assetError = false;
  await page.getByRole("link", { name: "View Organisations", exact: true }).click();
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).waitFor();
  await page.getByRole("link", { name: "Spatia home", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  // Organisation project links resolve through the current account, including later result pages
  await page.goto(`${origin}/admin/dashboard?projectId=${projects[3].projectId}`);
  await page.getByRole("region", { name: "Project details", exact: true }).waitFor();
  await page.getByRole("heading", { name: projects[3].title, exact: true }).waitFor();
  const projectRequests = "**/api/v1/projects?**";
  const lookupGate = Promise.withResolvers();
  const lookupStarted = Promise.withResolvers();
  await page.route(projectRequests, async (route) => {
    lookupStarted.resolve();
    await lookupGate.promise;
    await route.fallback();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await lookupStarted.promise;
    await page.locator('.admin-project-detail[aria-busy="true"]').waitFor();
    assert.equal(await page.locator(".admin-project-browser:visible, .admin-greeting").count(), 0);
  } finally {
    lookupGate.resolve();
  }
  await page.getByRole("heading", { name: projects[3].title, exact: true }).waitFor();
  await page.unroute(projectRequests);
  assert.equal(await page.getByRole("link", { name: projects[3].title, exact: true }).count(), 0);
  await page.goto(`${origin}/admin/dashboard?projectId=${archivedProject.projectId}`);
  await page
    .getByRole("region", { name: "Project details", exact: true })
    .getByRole("heading", { name: archivedProject.title, exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: archivedProject.title, exact: true }).count(),
    0,
  );
  await page.goto(`${origin}/admin/dashboard?projectId=00000000-0000-4000-8000-999999999999`);
  await page.getByRole("heading", { name: "All Published Projects", exact: true }).waitFor();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("projectId"));
  assert.equal(new URL(page.url()).searchParams.get("view"), "projects");
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "Stale project links leave the authorised catalogue usable",
  );
  assert.ok((await page.locator(".admin-project-browser .sp-catalogue-action").count()) > 0);
  assert.equal(await page.getByRole("region", { name: "Project details", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.has("projectId"), false);

  // Existing admin sessions also land on the dashboard; other roles retain their existing flow.
  await page.goto(origin + "/login");
  await page.waitForURL(origin + "/admin/dashboard");
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Dashboard fits ${width}px`,
    );
    if (width === 390)
      await page.screenshot({
        path: join(dirname(screenshot), "admin-dashboard-mobile.png"),
        fullPage: true,
      });
  }
  projectError = true;
  await page.reload();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "View Organisations", exact: true }).isVisible(),
    true,
  );
  projectError = false;
  await page.getByRole("button", { name: "Retry Projects", exact: true }).click();
  await page
    .getByRole("button", {
      name: `View Details for ${projects[0].title}`,
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.waitForURL(origin + "/login");
  await signIn();
  await page.waitForURL(origin + "/admin/dashboard");
  for (const other of ["Creator", "Educator"]) {
    role = other;
    await page.goto(origin + "/login");
    await page.waitForURL("**/home");
    const before = adminProjectReads;
    await page.goto(origin + "/admin/dashboard");
    await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
    assert.equal(adminProjectReads, before);
  }
  authenticated = false;
  await page.goto(origin + "/admin/dashboard");
  await page.waitForURL(origin + "/login");
  await page.getByRole("heading", { name: "Welcome back.", exact: true }).waitFor();
  authenticated = true;
  role = "Administrator";
  forced = true;
  await page.goto(origin + "/admin/dashboard");
  await page
    .getByRole("heading", {
      name: "Change your password to continue",
      exact: true,
    })
    .waitFor();
  await page.goto(origin + "/landing");
  await page.getByRole("heading", { name: /Build immersive/ }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/landing");
  assert.deepEqual(errors, []);
  console.log(
    "Admin dashboard checks passed: login routing, forced password change, sessions, access control, organisation creation, project browsing, details and pagination, assets, account navigation, error recovery and responsive layout.",
  );
} finally {
  await browser.close();
  await server?.close();
}
