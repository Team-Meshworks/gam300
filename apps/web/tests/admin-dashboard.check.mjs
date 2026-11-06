import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const server = process.argv[2]
  ? null
  : await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server?.listen();
const origin = process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser({ target: origin });
const screenshot = process.env.CHECK_SCREENSHOT ?? "../../.artifacts/admin-dashboard/desktop.png";
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
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
  permissions: { canEdit: true, canManage: true, canPublish: false },
}));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1212 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let authenticated = false;
  let role = "Administrator";
  let forced = false;
  let rejectLogin = false;
  let projectError = false;
  let projectReads = 0;
  let creations = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/session")
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
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { requestToken: "csrf" } });
    if (request.method() === "POST") {
      assert.equal(request.headers()["x-csrf-token"], "csrf");
      if (url.pathname === "/api/auth/login") {
        if (rejectLogin) return route.fulfill({ status: 401 });
        authenticated = true;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/auth/password") {
        forced = false;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/auth/logout") {
        assert.equal(request.headers()["x-spatia-account"], userId);
        authenticated = false;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/admin/organizations") {
        assert.equal(request.headers()["x-spatia-account"], userId);
        assert.deepEqual(request.postDataJSON(), { name: "New School" });
        creations++;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return route.fulfill({
          status: 201,
          json: { id: orgId, name: "New School", isActive: true },
        });
      }
    }
    if (url.pathname === "/api/projects") {
      projectReads++;
      if (new URL(request.headers().referer).pathname === "/admin/dashboard")
        assert.equal(request.headers()["x-spatia-account"], userId);
      if (projectError) return route.fulfill({ status: 503 });
      if (url.searchParams.get("archived") === "true")
        return route.fulfill({
          json: { items: [{ ...projects[1], archived: true }], nextCursor: null },
        });
      const cursor = url.searchParams.get("cursor");
      const items = cursor
        ? projects.slice(2)
        : projects.slice(0, url.searchParams.get("limit") === "3" ? 3 : 2);
      return route.fulfill({ json: { items, nextCursor: cursor ? null : items.at(-1).projectId } });
    }
    if (url.pathname === "/api/admin/organizations")
      return route.fulfill({
        json: {
          items: [{ id: orgId, name: "Ridgeview Secondary School", isActive: true }],
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
  await page
    .getByRole("link", { name: "Open project workspace", exact: true })
    .click({ timeout: 5000 });
  await page.waitForURL(origin + "/home");
  await page.getByRole("link", { name: "Accounts", exact: true }).click();
  await page.waitForURL(origin + "/accounts");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.waitForURL(origin + "/home");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  await page.getByRole("link", { name: "Open project workspace", exact: true }).click();
  await page.waitForURL(origin + "/home");
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.goto(origin + "/admin/dashboard");
  await page
    .getByRole("button", { name: `View details for ${projects[0].title}`, exact: true })
    .waitFor();
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  for (const [name, width, height] of [
    ["organisation.svg", 19, 19],
    ["environment.svg", 20, 20],
    ["library.svg", 33, 33],
  ]) {
    const geometry = await page
      .locator(`.admin-entry-symbol img[src*="${name.split(".")[0]}"]`)
      .evaluate((node) => ({
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
        loaded: node.complete && node.naturalWidth > 0,
      }));
    assert.deepEqual(geometry, { width, height, loaded: true });
  }
  await page.getByRole("button", { name: "View All Projects", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "All Projects", exact: true });
  await dialog.getByRole("button", { name: "Load more projects", exact: true }).click();
  await dialog
    .getByRole("button", { name: "View details for Ancient China", exact: true })
    .waitFor();
  await dialog.getByLabel("Search loaded projects").fill("Rome");
  assert.equal(await dialog.locator(".admin-project-card").count(), 1);
  async function escapeProjectDetails(archived) {
    const trigger = dialog.getByRole("button", {
      name: "View details for Life in Ancient Rome",
      exact: true,
    });
    const readsBefore = projectReads;
    await trigger.click();
    const details = page.getByRole("dialog", { name: "Project details", exact: true });
    await details.waitFor();
    assert.equal(
      await details.locator("dd").first().textContent(),
      archived ? "Archived" : "Draft",
    );
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" });
    assert.equal(await dialog.isVisible(), true, "Escape closes only the nested details dialog");
    assert.equal(await dialog.getByLabel("Search loaded projects").inputValue(), "Rome");
    assert.equal(await dialog.getByLabel("Project status").inputValue(), String(archived));
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    assert.equal(projectReads, readsBefore, "Returning to the list does not reload its pages");
  }
  await escapeProjectDetails(false);
  await dialog.getByLabel("Search loaded projects").fill("");
  assert.equal(await dialog.locator(".admin-project-card").count(), 4, "Loaded pages are retained");
  assert.equal(await dialog.getByRole("button", { name: "Load more projects" }).count(), 0);
  await dialog.getByLabel("Project status").selectOption("true");
  await dialog.getByRole("button", { name: "View details for Life in Ancient Rome" }).waitFor();
  await dialog.getByLabel("Search loaded projects").fill("Rome");
  await escapeProjectDetails(true);
  await dialog.getByLabel("Search loaded projects").fill("no matching project");
  await dialog.getByRole("status").filter({ hasText: "No matching projects" }).waitFor();
  // A focused search input consumes Escape to clear its value; test the dialog itself.
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "+ Add Organisations", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add organisation", exact: true });
  await dialog.getByLabel("Organisation name").fill(" New School ");
  await dialog
    .getByRole("button", { name: "Create organisation", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await dialog.waitFor({ state: "detached" });
  assert.equal(creations, 1);
  await page.getByRole("status").filter({ hasText: "New School was created." }).waitFor();
  for (const [button, title] of [
    ["View Environments", "3D Environments"],
    ["View Library", "Physical Asset Library"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    const library = page.getByRole("dialog", { name: title, exact: true });
    assert.ok((await library.locator(".admin-project-card").count()) > 0);
    await library.getByLabel("Search assets").fill("no matching asset");
    await page.getByRole("status").filter({ hasText: "No matching assets." }).waitFor();
    await library.getByRole("button", { name: "Close", exact: true }).click();
    await library.waitFor({ state: "detached" });
  }
  await page.getByRole("link", { name: "View Organisations", exact: true }).click();
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).waitFor();
  await page.getByRole("link", { name: "Spatia home", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
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
  await page.getByRole("button", { name: "Retry projects", exact: true }).click();
  await page
    .getByRole("button", { name: `View details for ${projects[0].title}`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.waitForURL(origin + "/login");
  await signIn();
  await page.waitForURL(origin + "/admin/dashboard");
  for (const other of ["Creator", "Educator"]) {
    role = other;
    await page.goto(origin + "/login");
    await page.getByRole("heading", { name: "You’re signed in.", exact: true }).waitFor();
    const before = projectReads;
    await page.goto(origin + "/admin/dashboard");
    await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
    assert.equal(projectReads, before);
  }
  authenticated = false;
  await page.goto(origin + "/admin/dashboard");
  await page.getByRole("heading", { name: "Log in to continue", exact: true }).waitFor();
  authenticated = true;
  role = "Administrator";
  forced = true;
  await page.reload();
  await page.getByRole("heading", { name: "Password change required", exact: true }).waitFor();
  await page.goto(origin + "/landing");
  await page.getByRole("heading", { name: /Build immersive/ }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/landing");
  assert.deepEqual(errors, []);
  console.log(
    "Admin dashboard checks passed: login routing, forced password change, sessions, access control, organisation creation, project pagination, nested-dialog Escape, assets, account navigation, error recovery and responsive layout.",
  );
} finally {
  await browser.close();
  await server?.close();
}
