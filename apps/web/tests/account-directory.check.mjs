import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";

const server = process.argv[2]
  ? null
  : await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server?.listen();
const origin = process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser({ target: origin });
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const rows = [];
const writes = [];
let duplicate = false;
let organizationActive = true;
let organizationName = "Ridgeview Secondary School";
let emptyProjects = false;
let failOrganizations = false;
let projectTitle = "The Silk Road: A Journey Through History";
const reads = { accounts: 0, projects: 0 };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId,
          displayName: "VThere",
          role: "Administrator",
          orgId: null,
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test-csrf" } });
    if (req.method() !== "GET") {
      assert.equal(req.headers()["x-csrf-token"], "test-csrf");
      const body = req.postDataJSON();
      writes.push({ path, body });
      if (duplicate) return route.fulfill({ status: 409, json: { code: "username_taken" } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (req.method() === "DELETE" && path === `/api/v1/admin/users/${userId}`) {
        rows.splice(0, 1);
        return route.fulfill({ status: 204 });
      }
      if (path === `/api/v1/admin/organizations/${orgId}/active`) {
        organizationActive = body.isActive;
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith("/active")) {
        rows[0].isActive = body.isActive;
        return route.fulfill({ status: 204 });
      }
      if (req.method() === "POST") {
        rows.push({
          userId,
          orgId,
          displayName: body.displayName,
          userName: body.userName,
          role: body.role,
          isActive: true,
          mustChangePassword: true,
        });
      } else {
        for (const key of ["displayName", "userName", "role"])
          if (key in body) rows[0][key] = body[key];
      }
      return route.fulfill({ status: req.method() === "POST" ? 201 : 200, json: rows[0] });
    }
    if (path === "/api/v1/admin/organizations" && failOrganizations)
      return route.fulfill({ status: 503, json: { code: "directory_unavailable" } });
    if (path === "/api/v1/admin/organizations") {
      const query = (new URL(req.url()).searchParams.get("q") ?? "").toLowerCase();
      const matches =
        organizationName.toLowerCase().includes(query) ||
        rows.some(
          (row) =>
            row.userName.toLowerCase().includes(query) ||
            row.displayName.toLowerCase().includes(query),
        );
      return route.fulfill({
        json: {
          items: matches
            ? [
                {
                  id: orgId,
                  name: organizationName,
                  isActive: organizationActive,
                  projectCount: emptyProjects ? 0 : 2,
                  facilitatorCount: rows.filter((row) => row.role === "Educator").length,
                  creatorCount: rows.filter((row) => row.role === "Creator").length,
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    }
    if (path.endsWith("/projects")) {
      reads.projects++;
      if (emptyProjects) {
        return route.fulfill({ json: { items: [], nextCursor: null } });
      }

      return route.fulfill({
        json: {
          items: [
            { id: userId, title: projectTitle, status: "Draft", isPublic: false },
            {
              id: "bbf2b1d0-b388-4df8-a995-930148dcdd19",
              title: "Project with cover",
              status: "Draft",
              isPublic: true,
              cover: "/entry/assets/login-exhibit.png",
            },
          ],
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/admin/users") {
      reads.accounts++;
      return route.fulfill({ json: { items: rows, nextCursor: null } });
    }
    if (path === `/api/v1/admin/users/${userId}`) return route.fulfill({ json: rows[0] });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/organisations`);
  await page.getByRole("heading", { name: "All Organisations", level: 1, exact: true }).waitFor();
  const screenshots = process.env.CHECK_SCREENSHOTS ?? "../../.artifacts/account-directory";
  await mkdir(screenshots, { recursive: true });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Organisation overview fits ${width}px`,
    );
    const card = page.locator(".sp-organization-card").first();
    assert.equal(
      await card.locator(".sp-avatar").evaluate((node) => node.getBoundingClientRect().height),
      44,
    );
    assert.equal(
      await card.getByRole("button").evaluate((node) => node.getBoundingClientRect().height),
      44,
    );
    if (width === 1440 || width === 390) {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({
        path: `${screenshots}/organisation-overview-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Accounts", exact: true }).count(), 0);
  assert.equal(await page.getByText("Manage accounts within an organisation.").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Refresh directory" }).count(), 0);
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  const identity = page.getByRole("heading", { name: "Ridgeview Secondary School", exact: true });
  const projects = page.getByRole("tab", { name: "All Projects", exact: true });
  await projects.waitFor();
  assert.equal(
    await identity.evaluate((node) =>
      node
        .closest("section")
        ?.contains(
          [...document.querySelectorAll("h2, h3, h4")].find(
            (heading) => heading.textContent === "All Projects",
          ),
        ),
    ),
    false,
    "Organisation identity and projects occupy separate sections",
  );
  assert.equal(await page.getByRole("navigation", { name: "Workspace" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Refresh directory" }).count(), 0);
  const defaultCard = page.locator(".sp-directory-project").filter({ hasText: projectTitle });
  await defaultCard.getByRole("heading", { name: projectTitle }).waitFor();
  const defaultCover = defaultCard.locator("img");
  assert.equal(await defaultCover.count(), 1, "a project without a cover has a default image");
  assert.match(
    await defaultCover.getAttribute("src"),
    /default-project-neutral(?:-[\w-]+)?\.jpg(?:\?|$)/,
  );
  await defaultCover.evaluate((image) => image.decode());
  const explicitCover = page
    .locator(".sp-directory-project")
    .filter({ hasText: "Project with cover" })
    .locator("img");
  assert.equal(await explicitCover.getAttribute("src"), "/entry/assets/login-exhibit.png");
  await explicitCover.evaluate((image) => image.decode());
  assert.equal(
    await defaultCard.getByRole("link", { name: "View Details" }).getAttribute("href"),
    `/admin/dashboard?projectId=${userId}`,
  );
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  assert.equal(await defaultCard.count(), 0);
  await page.getByRole("heading", { name: "Project with cover", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Private", exact: true }).click();
  await defaultCard.waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Project with cover", exact: true }).count(),
    0,
  );
  await projects.click();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Show", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "+ Add Accounts", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Hide", exact: true }).waitFor();
  writes.length = 0;
  await page.getByRole("button", { name: "+ Add Accounts", exact: true }).focus();
  await page.keyboard.press("Enter");
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).focus();
  await page.keyboard.type("Aisyah Abdullah");
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog
      .getByLabel("Username", { exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.type("aisyah");
  await dialog.getByLabel("Password", { exact: true }).fill("Synthetic-password1!");
  await dialog.getByRole("button", { name: "Show password", exact: true }).click();
  assert.equal(await dialog.getByLabel("Password", { exact: true }).getAttribute("type"), "text");
  await dialog.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.screenshot({ path: `${screenshots}/create-account.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Save Changes" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await dialog.waitFor({ state: "detached" });
  assert.equal(writes.length, 1, "Pending saves cannot create duplicate requests");
  assert.equal(writes[0].body.orgId, orgId);
  await page.getByRole("button", { name: "View account for Aisyah Abdullah" }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("Password", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByLabel("Name", { exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "Save Changes" }).isDisabled(), true);
  await page.screenshot({ path: `${screenshots}/view-account.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Override name", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Aisyah Tan");
  await dialog.getByRole("button", { name: "Override username", exact: true }).click();
  await dialog.getByLabel("Username", { exact: true }).fill("aisyah.tan");
  duplicate = true;
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await dialog.getByRole("alert").filter({ hasText: "already taken" }).waitFor();
  assert.equal(await dialog.getByLabel("Name", { exact: true }).inputValue(), "Aisyah Tan");
  duplicate = false;
  await dialog.getByRole("button", { name: "Override account type", exact: true }).click();
  const accountType = dialog.getByRole("combobox", { name: "Account Type", exact: true });
  await accountType.focus();
  await page.keyboard.press("ArrowDown");
  const accountTypes = page.getByRole("listbox", { name: "Account Type", exact: true });
  await accountTypes.waitFor();
  const typeFieldBounds = await accountType.boundingBox();
  const typeMenuBounds = await accountTypes.boundingBox();
  assert.ok(
    Math.abs(typeFieldBounds.width - typeMenuBounds.width) < 1,
    "Account choices span their field",
  );
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await accountTypes.waitFor({ state: "hidden" });
  assert.equal(await accountType.textContent(), "Facilitator");
  assert.equal(await accountType.evaluate((node) => node === document.activeElement), true);
  await dialog.getByRole("button", { name: "Override password", exact: true }).focus();
  await page.keyboard.press("Enter");
  await dialog.getByLabel("New Password", { exact: true }).fill("Replacement-password2!");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(writes.at(-1).body, {
    displayName: "Aisyah Tan",
    userName: "aisyah.tan",
    role: "Educator",
    newTemporaryPassword: "Replacement-password2!",
  });
  await page.reload();
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.getByRole("button", { name: "View account for Aisyah Tan" }).waitFor();
  await page.getByRole("tab", { name: "Creators (0)", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "View account for Aisyah Tan" }).count(), 0);
  await page.getByRole("tab", { name: "Facilitators (1)", exact: true }).click();
  await page.getByLabel("Search accounts").fill("aisyah.tan");
  await page.getByRole("button", { name: "View account for Aisyah Tan" }).waitFor();
  await page.getByRole("tab", { name: "All Accounts (1)", exact: true }).click();
  await page.getByLabel("Search accounts").fill("");
  await page.getByLabel("Search accounts").blur();
  await page.screenshot({ path: `${screenshots}/directory.png`, fullPage: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    await page.screenshot({
      path: `${screenshots}/organisation-detail-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.getByRole("button", { name: "Hide account for Aisyah Tan" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Show account for Aisyah Tan" }).waitFor();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Directory fits ${width}px`,
    );
    await page.getByRole("button", { name: "View account for Aisyah Tan" }).click();
    dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
      `Dialog fits ${width}px`,
    );
    if (width === 390)
      await page.screenshot({ path: `${screenshots}/mobile-account.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  }
  // Returning to the list must clear the selected organisation so reopening it fetches fresh data.
  await page.evaluate(() => {
    window.heardSounds = [];
    HTMLMediaElement.prototype.play = function () {
      window.heardSounds.push(new URL(this.src).pathname);
      return Promise.resolve();
    };
  });
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  assert.equal(
    await page
      .getByRole("heading", { name: "All Organisations", level: 1, exact: true })
      .isVisible(),
    true,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.heardSounds.map((path) =>
        path
          .split("/")
          .pop()
          .replace(/-[\w-]{8}\.wav$/, ".wav"),
      ),
    ),
    ["going-back.wav"],
    "Returning to the organisation list keeps the navigation sound",
  );
  await page.getByLabel("Search organisations").fill("aisyah.tan");
  const overviewCard = page.locator(".sp-organization-card");
  await overviewCard.getByText("1 Facilitator", { exact: true }).waitFor();
  assert.equal(await overviewCard.getByText("2 Projects", { exact: true }).isVisible(), true);
  assert.equal(await overviewCard.getByText("0 Creators", { exact: true }).isVisible(), true);
  assert.equal(
    await overviewCard.getByRole("button", { name: "Open Ridgeview Secondary School" }).isVisible(),
    true,
    "An account search keeps its organisation even when the organisation name does not match",
  );
  await page.getByLabel("Search organisations").fill("no matching account");
  await page.getByText("No matching organisations. Try another name.", { exact: true }).waitFor();
  await page.getByLabel("Search organisations").fill("");
  rows[0].displayName = "Aisyah Refreshed";
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.getByRole("button", { name: "View account for Aisyah Refreshed" }).waitFor();
  // A failed initial directory load remains recoverable.
  failOrganizations = true;
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "directory request failed" }).waitFor();
  failOrganizations = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.getByRole("button", { name: "View account for Aisyah Refreshed" }).waitFor();
  const beforeReopen = { ...reads };
  rows[0].displayName = "Aisyah Recovered";
  projectTitle = "Recovered project";
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.getByRole("button", { name: "View account for Aisyah Recovered" }).waitFor();
  await page.getByRole("heading", { name: projectTitle, exact: true }).waitFor();
  assert.ok(reads.accounts > beforeReopen.accounts && reads.projects > beforeReopen.projects);
  await page.getByRole("button", { name: "Delete account for Aisyah Recovered" }).click();
  const deletionDialog = page.getByRole("dialog", { name: "Delete Account", exact: true });
  await deletionDialog
    .getByText(/Their username, authored projects and review history will be retained/)
    .waitFor();
  await deletionDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Delete account for Aisyah Recovered" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete Account", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View account for Aisyah Recovered" })
    .waitFor({ state: "detached" });
  assert.equal(writes.at(-1).path, `/api/v1/admin/users/${userId}`);
  await page
    .getByText("No accounts yet. Add the first account to this organisation.", { exact: true })
    .waitFor();
  emptyProjects = true;
  organizationName =
    "Sengkang Secondary School with an exceptionally long organisation name for accessible zoom verification";
  await page.reload();
  await page.getByRole("button", { name: `Open ${organizationName}`, exact: true }).click();
  await page.getByText("No projects in this organisation.", { exact: true }).waitFor();
  const emptyAccounts = page.getByText(
    "No accounts yet. Add the first account to this organisation.",
    { exact: true },
  );
  await emptyAccounts.waitFor();
  const emptyProjectsText = page.getByText("No projects in this organisation.", { exact: true });
  assert.equal(await emptyAccounts.evaluate((node) => getComputedStyle(node).fontSize), "14px");
  assert.equal(await emptyProjectsText.evaluate((node) => getComputedStyle(node).fontSize), "14px");
  for (const [width, zoom] of [
    [1440, 1],
    [1440, 1.5],
    [390, 1],
  ]) {
    // Emulate browser zoom through its effective CSS viewport so responsive breakpoints also apply
    await page.setViewportSize({
      width: Math.round(width / zoom),
      height: Math.round(1024 / zoom),
    });
    const geometry = await page.locator(".sp-directory--administration").evaluate((panel) => {
      const box = panel.querySelector(".sp-account-list").getBoundingClientRect();
      const close = panel
        .querySelector('[aria-label="Close organisation"]')
        .getBoundingClientRect();
      const search = panel
        .querySelector(".sp-account-search-row .sp-search")
        .getBoundingClientRect();
      return {
        inside:
          close.left >= box.left &&
          close.top >= box.top &&
          close.right <= box.right &&
          close.bottom <= box.bottom,
        overlaps:
          close.left < search.right &&
          close.right > search.left &&
          close.top < search.bottom &&
          close.bottom > search.top,
      };
    });
    assert.deepEqual(
      geometry,
      { inside: true, overlaps: false },
      `Close control is inside the white account panel at ${width}px and ${zoom} zoom`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      path: `${screenshots}/organisation-empty-${width}-${zoom}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  assert.ok(!storage.includes("password1") && !storage.includes("password2"));
  assert.deepEqual(errors, []);
  console.log(
    "Account directory browser checks passed: create, override, errors, reload, filters, lifecycle, mobile, return navigation, failed-load recovery and sound.",
  );
} finally {
  await browser.close();
  await server?.close();
}
