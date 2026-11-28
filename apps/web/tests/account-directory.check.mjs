import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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
let pendingAccountCreate;
let failedBulkDelete;
let loseImportReceipt = false;
const importReceipts = new Map();
const bulkImportsPath = `/api/v1/admin/organizations/${orgId}/bulk-imports`;
const isBulkCreate = (path) =>
  path.startsWith(`${bulkImportsPath}/`) &&
  /^[\da-f-]{36}$/.test(path.slice(bulkImportsPath.length + 1));
let organizationActive = true;
let organizationName = "Ridgeview Secondary School";
let emptyProjects = false;
let failOrganizations = false;
let releaseOrganizations;
let organizationGate = new Promise((resolve) => {
  releaseOrganizations = resolve;
});
let projectTitle = "The Silk Road: A Journey Through History";
const reads = { accounts: 0, projects: 0 };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const serveApi = async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const accountId = /^\/api\/v1\/admin\/users\/([^/]+)$/.exec(path)?.[1];
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId,
          displayName: "Alex Morgan",
          role: "Administrator",
          orgId: null,
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/admin/projects/publication-moderation") {
      const ids = new URL(req.url()).searchParams.get("ids").split(",");
      return route.fulfill({
        json: {
          items: ids.map((projectId) => ({
            projectId,
            publicationCount: projectId === "cccccccc-cccc-4ccc-8ccc-cccccccccccc" ? 0 : 1,
            hiddenCount: 0,
            publicCount:
              projectId === userId || projectId === "cccccccc-cccc-4ccc-8ccc-cccccccccccc" ? 0 : 1,
          })),
        },
      });
    }
    if (path === bulkImportsPath && req.method() === "GET") {
      assert.equal(req.headers()["x-spatia-account"], userId);
      if (!organizationActive)
        return route.fulfill({ status: 404, json: { code: "bulk_import_not_found" } });
      return route.fulfill({
        json: {
          items: [...importReceipts.values()]
            .filter((receipt) => !receipt.acknowledged)
            .map(({ operationId, expiresAt, created }) => ({
              operationId,
              createdAt: new Date(Date.parse(expiresAt) - 86400000).toISOString(),
              expiresAt,
              createdCount: created.length,
            })),
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test-csrf" } });
    if (req.method() !== "GET") {
      assert.equal(req.headers()["x-csrf-token"], "test-csrf");
      const body = req.postDataJSON();
      writes.push({ path, body });
      if (duplicate) return route.fulfill({ status: 409, json: { code: "username_taken" } });
      if (req.method() === "DELETE" && accountId) {
        const index = rows.findIndex((row) => row.userId === accountId);
        if (index === -1) return route.fulfill({ status: 404 });
        rows.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
      if (path === `/api/v1/admin/organizations/${orgId}/active`) {
        organizationActive = body.isActive;
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith("/active")) {
        rows.find((row) => row.userId === path.split("/").at(-2)).isActive = body.isActive;
        return route.fulfill({ status: 204 });
      }
      if (path === `/api/v1/admin/organizations/${orgId}/accounts/hide`) {
        assert.ok(
          body.userIds.every((id) =>
            rows.some((row) => row.userId === id && ["Creator", "Educator"].includes(row.role)),
          ),
        );
        for (const row of rows) if (body.userIds.includes(row.userId)) row.isActive = false;
        return route.fulfill({ status: 204 });
      }
      if (path === `/api/v1/admin/organizations/${orgId}/accounts/delete`) {
        if (failedBulkDelete) {
          await failedBulkDelete.promise;
          return route.fulfill({ status: 503, json: { code: "directory_unavailable" } });
        }
        assert.ok(
          body.userIds.every((id) =>
            rows.some((row) => row.userId === id && ["Creator", "Educator"].includes(row.role)),
          ),
        );
        for (let index = rows.length - 1; index >= 0; index--)
          if (body.userIds.includes(rows[index].userId)) rows.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
      if (path.startsWith(`${bulkImportsPath}/`) && req.method() === "POST") {
        assert.equal(req.headers()["x-spatia-account"], userId);
        const [operationId, action] = path.split("/").slice(-2);
        const receipt = importReceipts.get(operationId);
        if (!receipt)
          return route.fulfill({ status: 404, json: { code: "bulk_import_not_found" } });
        if (action === "receipt") return route.fulfill({ json: receipt });
        assert.equal(action, "acknowledge");
        receipt.acknowledged = true;
        receipt.credentials = [];
        return route.fulfill({ status: 204 });
      }
      if (isBulkCreate(path)) {
        assert.equal(req.method(), "PUT");
        assert.equal(req.headers()["x-spatia-account"], userId);
        const created = body
          .filter((value) => !rows.some((row) => row.userName === value.userName))
          .map((value) => ({
            ...value,
            initialPassword: undefined,
            userId: randomUUID(),
            isActive: true,
            mustChangePassword: true,
          }));
        rows.push(...created);
        const operationId = path.split("/").at(-1);
        const receipt = {
          operationId,
          orgId,
          created: created.map(({ userId, userName, displayName, role }) => ({
            userId,
            userName,
            displayName,
            role,
          })),
          credentials: created.map(({ userId, userName }) => ({
            userId,
            userName,
            password: body.find((row) => row.userName === userName).initialPassword,
          })),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          acknowledged: false,
        };
        importReceipts.set(operationId, receipt);
        if (loseImportReceipt) {
          loseImportReceipt = false;
          return route.abort("failed");
        }
        return route.fulfill({
          status: created.length ? 201 : 200,
          json: receipt,
        });
      }
      if (req.method() === "POST" && path === "/api/v1/admin/users") {
        await pendingAccountCreate?.promise;
        const account = {
          userId: randomUUID(),
          orgId,
          displayName: body.displayName,
          userName: body.userName,
          role: body.role,
          isActive: true,
          mustChangePassword: true,
        };
        rows.push(account);
        return route.fulfill({ status: 201, json: account });
      }
      const account = rows.find((row) => row.userId === accountId);
      if (!account) return route.fulfill({ status: 404 });
      for (const key of ["displayName", "userName", "role"])
        if (key in body) account[key] = body[key];
      return route.fulfill({ json: account });
    }
    if (path === "/api/v1/admin/organizations" && failOrganizations)
      return route.fulfill({ status: 503, json: { code: "directory_unavailable" } });
    if (path === "/api/v1/admin/organizations") {
      if (organizationGate) await organizationGate;
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
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              title: "Unpublished draft fixture",
              status: "Draft",
              isPublic: false,
            },
            {
              id: "bbf2b1d0-b388-4df8-a995-930148dcdd19",
              title: "Published directory project",
              status: "Draft",
              isPublic: true,
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
    const account = rows.find((row) => row.userId === accountId);
    if (account) return route.fulfill({ json: account });
    return route.fulfill({ status: 404 });
  };
  await context.route("**/api/v1/**", serveApi);
  await page.goto(`${origin}/organisations`);
  await page.getByRole("heading", { name: "All Organisations", level: 1, exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Search organisations" }).waitFor();
  await page.getByRole("status", { name: "Loading organisations" }).waitFor();
  releaseOrganizations();
  organizationGate = null;
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).waitFor();
  organizationGate = new Promise((resolve) => {
    releaseOrganizations = resolve;
  });
  await page.goto(`${origin}/organisations?organisation=${orgId}`);
  await page.getByRole("status", { name: "Loading organisation", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "All Organisations", exact: true }).count(),
    0,
  );
  releaseOrganizations();
  organizationGate = null;
  await page.getByRole("heading", { name: "Ridgeview Secondary School" }).waitFor();
  await page.goto(`${origin}/organisations`);
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).waitFor();
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
      50,
    );
    assert.equal(
      await card.getByRole("button").evaluate((node) => node.getBoundingClientRect().height),
      40,
    );
    assert.equal(
      await card
        .locator(".sp-organization-counts")
        .evaluate((node) => getComputedStyle(node).flexDirection),
      "column",
    );
    if (width === 1440)
      assert.equal(
        await page
          .locator(".sp-organization-grid")
          .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
        2,
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
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  const identity = page.getByRole("heading", { name: "Ridgeview Secondary School", exact: true });
  const projects = page.getByRole("tab", { name: "All Published", exact: true });
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
  const defaultCard = page.locator(".sp-directory-project").filter({ hasText: projectTitle });
  await defaultCard.getByRole("heading", { name: projectTitle }).waitFor();
  const defaultCover = defaultCard.locator("img");
  assert.equal(await defaultCover.isVisible(), true, "a project has a visible default image");
  await defaultCover.evaluate((image) => image.decode());
  assert.equal(
    await defaultCard.getByRole("link", { name: "View Details" }).getAttribute("href"),
    `/admin/dashboard?projectId=${userId}`,
  );
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  assert.equal(await defaultCard.count(), 0);
  await page.getByRole("heading", { name: "Published directory project", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Private", exact: true }).click();
  await defaultCard.waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Published directory project", exact: true }).count(),
    0,
  );
  await projects.click();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Show", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Add Accounts", exact: true }).isDisabled(),
    true,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Show", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry account imports" }).count(), 0);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Hide", exact: true }).waitFor();
  writes.length = 0;
  await page.getByRole("button", { name: "Add Accounts", exact: true }).focus();
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
  pendingAccountCreate = Promise.withResolvers();
  try {
    await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/admin/users",
      ),
      dialog.getByRole("button", { name: "Save changes" }).evaluate((button) => {
        button.click();
        button.click();
      }),
    ]);
  } finally {
    pendingAccountCreate.resolve();
    pendingAccountCreate = undefined;
  }
  await dialog.waitFor({ state: "detached" });
  assert.equal(writes.length, 1, "Pending saves cannot create duplicate requests");
  assert.equal(writes[0].body.orgId, orgId);
  const createdAccountId = rows[0].userId;
  await page.getByRole("button", { name: "View account for Aisyah Abdullah" }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("Password", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByLabel("Name", { exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "Save changes" }).isDisabled(), true);
  await page.screenshot({ path: `${screenshots}/view-account.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Override name", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Aisyah Tan");
  await dialog.getByRole("button", { name: "Override username", exact: true }).click();
  await dialog.getByLabel("Username", { exact: true }).fill("aisyah.tan");
  duplicate = true;
  await dialog.getByRole("button", { name: "Save changes" }).click();
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
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(writes.at(-1).body, {
    displayName: "Aisyah Tan",
    userName: "aisyah.tan",
    role: "Educator",
    newTemporaryPassword: "Replacement-password2!",
  });
  assert.equal(new URL(page.url()).searchParams.get("organisation"), orgId);
  await page.reload();
  await page.getByRole("button", { name: "Close organisation", exact: true }).waitFor();
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
  assert.equal(new URL(page.url()).searchParams.has("organisation"), false);
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
  assert.equal(
    await overviewCard.getByText("2 Published Projects", { exact: true }).isVisible(),
    true,
  );
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
  await page.getByRole("button", { name: "Close organisation", exact: true }).waitFor();
  await page.getByRole("button", { name: "View account for Aisyah Refreshed" }).waitFor();
  const beforeReopen = { ...reads };
  rows[0].displayName = "Aisyah Recovered";
  projectTitle = "Recovered project";
  await page.getByRole("button", { name: "Close organisation", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.has("organisation"), false);
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
  assert.equal(writes.at(-1).path, `/api/v1/admin/users/${createdAccountId}`);
  await page
    .getByText("No accounts yet. Add the first account to this organisation.", { exact: true })
    .waitFor();
  emptyProjects = true;
  organizationName =
    "Sengkang Secondary School with an exceptionally long organisation name for accessible zoom verification";
  await page.reload();
  await page.getByRole("button", { name: "Close organisation", exact: true }).waitFor();
  await page.getByText("No published projects in this organisation.", { exact: true }).waitFor();
  const emptyAccounts = page.getByText(
    "No accounts yet. Add the first account to this organisation.",
    { exact: true },
  );
  await emptyAccounts.waitFor();
  const emptyProjectsText = page.getByText("No published projects in this organisation.", {
    exact: true,
  });
  assert.equal(await emptyAccounts.evaluate((node) => getComputedStyle(node).fontSize), "13px");
  assert.equal(await emptyProjectsText.evaluate((node) => getComputedStyle(node).fontSize), "13px");
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
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const csvDialog = page.getByRole("dialog", { name: "Account Creation", exact: true });
  const csvSizes = new Map();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    csvSizes.set(width, await csvDialog.boundingBox());
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  await csvDialog.getByLabel("Name", { exact: true }).fill("Preserved manual entry");
  const cancelledPicker = page.waitForEvent("filechooser");
  await csvDialog.getByRole("button", { name: "Upload CSV", exact: true }).hover();
  await csvDialog.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (await cancelledPicker).setFiles([]);
  await csvDialog
    .locator('input[type="file"]')
    .evaluate((input) => input.dispatchEvent(new Event("cancel", { bubbles: true })));
  assert.equal(
    await csvDialog.isVisible(),
    true,
    "File picker cancellation keeps Account Creation open",
  );
  assert.equal(
    await csvDialog.getByLabel("Name", { exact: true }).inputValue(),
    "Preserved manual entry",
  );
  const chooser = page.waitForEvent("filechooser");
  await csvDialog.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "learners.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Name,DOB,Account Type\nCSV Learner,2008-01-02,Creator\nCSV Student,03/04/2009,Facilitator",
    ),
  });
  await csvDialog.getByText("2 accounts ready to import.", { exact: true }).waitFor();
  assert.equal(
    writes.filter((write) => isBulkCreate(write.path)).length,
    0,
    "Uploading only prepares accounts",
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    const ready = await csvDialog.boundingBox(),
      before = csvSizes.get(width);
    assert.equal(ready.width, before.width, `Upload preserves width at ${width}px`);
    assert.equal(ready.height, before.height, `Upload preserves height at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  const download = page.waitForEvent("download");
  await csvDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "account-credentials.csv");
  await csvDialog.waitFor({ state: "detached" });
  const batch = writes.filter((write) => isBulkCreate(write.path));
  assert.equal(batch.length, 1, "One upload click sends exactly one batch");
  assert.deepEqual(
    batch[0].body.map((value) => value.role),
    ["Creator", "Educator"],
  );
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const repeated = page.getByRole("dialog", { name: "Account Creation", exact: true });
  const repeatedChooser = page.waitForEvent("filechooser");
  await repeated.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (
    await repeatedChooser
  ).setFiles({
    name: "mixed-existing.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Name,DOB\nCSV Learner,2008-01-02\nCSV Fresh Learner,2009-03-04\nBad Date,invalid",
    ),
  });
  await repeated.getByText("2 accounts ready to import.", { exact: true }).waitFor();
  const importBounds = new Map();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    importBounds.set(width, await repeated.boundingBox());
  }
  const freshDownload = page.waitForEvent("download");
  await repeated.getByRole("button", { name: "Save changes", exact: true }).click();
  const credentialsFile = await freshDownload;
  const credentialsText = await readFile(await credentialsFile.path(), "utf8");
  assert.ok(credentialsText.includes('"CSV Fresh Learner"'));
  assert.ok(
    !credentialsText.includes('"CSV Learner"'),
    "Skipped accounts must not receive new credentials",
  );
  await repeated
    .getByText("1 account created, 2 rows skipped (row 2, row 4).", { exact: true })
    .waitFor();
  await repeated
    .getByTitle("Row 2: Account already exists\nRow 4: Invalid date of birth", { exact: true })
    .waitFor();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1024 });
    const summary = await repeated.getByRole("status").boundingBox();
    const notes = await repeated.locator(".sp-account-notes").boundingBox();
    assert.ok(
      Math.abs(summary.y + summary.height / 2 - notes.y - notes.height / 2) < 1,
      `Result shares the helper text alignment at ${width}px`,
    );
    assert.deepEqual(
      await repeated.boundingBox(),
      importBounds.get(width),
      `Reporting skipped rows preserves the dialog bounds at ${width}px`,
    );
  }
  await repeated.getByRole("button", { name: "Done" }).click();
  await repeated.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "View account for CSV Fresh Learner", exact: true })
    .waitFor();
  const deleteWrites = () => writes.filter((write) => write.path.endsWith("/accounts/delete"));
  assert.equal(await page.getByRole("button", { name: "Select all", exact: true }).count(), 0);
  const toolbarHeight = await page
    .locator(".sp-account-list-header")
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Select accounts", exact: true }).click();
  assert.equal(
    await page
      .locator(".sp-account-list-header")
      .evaluate((node) => node.getBoundingClientRect().height),
    toolbarHeight,
  );
  assert.ok(
    (await page.locator(".sp-account-row-bottom").count()) > 0,
    "Selection mode preserves the View Account action",
  );
  assert.equal(
    await page.getByText("Unpublished draft fixture", { exact: true }).count(),
    0,
    "Organisation projects exclude unpublished drafts",
  );
  assert.ok((await page.getByRole("button", { name: /^Hide account for / }).count()) > 0);
  assert.ok((await page.getByRole("button", { name: /^Delete account for / }).count()) > 0);
  assert.ok((await page.getByRole("button", { name: /^View account for / }).count()) > 0);
  const searchAccounts = page.getByRole("searchbox", { name: "Search accounts", exact: true });
  await searchAccounts.fill("CSV Fresh Learner");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Hide selected", exact: true }).click();
  const hideSelected = page.getByRole("dialog", { name: "Hide 1 account?", exact: true });
  await hideSelected.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(rows.find((row) => row.displayName === "CSV Fresh Learner")?.isActive, true);
  await page.getByRole("button", { name: "Hide selected", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Hide 1 account?", exact: true })
    .getByRole("button", { name: "Hide Accounts", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Hide 1 account?", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(rows.find((row) => row.displayName === "CSV Fresh Learner")?.isActive, false);
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  let deletion = page.getByRole("dialog", { name: "Delete 1 account?", exact: true });
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(deleteWrites().length, 0, "Cancelling bulk deletion sends no request");
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete 1 account?", exact: true })
    .getByRole("button", { name: "Delete 1 account", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Select accounts", exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /^Select creator / }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Cancel selection", exact: true }).count(),
    0,
    "Deleting a subset of accounts exits selection mode",
  );
  assert.equal(
    await searchAccounts.inputValue(),
    "CSV Fresh Learner",
    "Deletion preserves the search",
  );
  await searchAccounts.fill("");
  await page.getByRole("button", { name: "Select accounts", exact: true }).click();
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  assert.ok(
    (await page.locator(".sp-account-row-bottom").count()) > 0,
    "Cancelling restores individual actions",
  );
  await page.getByRole("button", { name: "Select accounts", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Delete selected", exact: true }).isDisabled(),
    true,
  );
  const selectedIds = rows.map((row) => row.userId);
  const studentIds = rows.filter((row) => row.role === "Creator").map((row) => row.userId);
  const selectedCreators = rows.filter((row) => row.role === "Creator");
  const facilitatorIds = rows.filter((row) => row.role === "Educator").map((row) => row.userId);
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Select creator / }).count(),
    studentIds.length,
  );
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  deletion = page.getByRole("dialog", {
    name: `Delete ${selectedIds.length} accounts?`,
    exact: true,
  });
  await deletion
    .getByText(/Their usernames, projects and review history will be retained/)
    .waitFor();
  const confirmationText = await deletion.innerText();
  assert.ok(
    selectedCreators.every(({ displayName }) => !confirmationText.includes(displayName)),
    "Bulk deletion does not list selected creators",
  );
  await page.screenshot({ path: `${screenshots}/bulk-delete.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${screenshots}/bulk-delete-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1024 });
  const deletionWritesBeforeFailure = deleteWrites().length;
  failedBulkDelete = Promise.withResolvers();
  try {
    await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname ===
            `/api/v1/admin/organizations/${orgId}/accounts/delete`,
      ),
      deletion
        .getByRole("button", { name: `Delete ${selectedIds.length} accounts`, exact: true })
        .dblclick(),
    ]);
  } finally {
    failedBulkDelete.resolve();
  }
  await deletion.getByRole("alert").waitFor();
  assert.equal(
    deleteWrites().length,
    deletionWritesBeforeFailure + 1,
    "A double click sends one bulk request",
  );
  assert.ok(
    selectedIds.every((id) => rows.some((row) => row.userId === id)),
    "Failed deletion preserves accounts",
  );
  failedBulkDelete = undefined;
  await deletion
    .getByRole("button", { name: `Delete ${selectedIds.length} accounts`, exact: true })
    .click();
  await deletion.waitFor({ state: "detached" });
  assert.deepEqual(deleteWrites().at(-1).body.userIds.sort(), selectedIds.sort());
  assert.ok(
    facilitatorIds.every((id) => !rows.some((row) => row.userId === id)),
    "Bulk deletion includes selected facilitators",
  );
  assert.equal(await page.getByRole("checkbox", { name: /^Select creator / }).count(), 0);
  await page.getByRole("button", { name: "Select accounts", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const staged = page.getByRole("dialog", { name: "Account Creation", exact: true });
  await staged.getByLabel("Name", { exact: true }).fill("Manual Must Not Post");
  await staged.getByLabel("Username", { exact: true }).fill("manual-must-not-post");
  await staged.getByLabel("Password", { exact: true }).fill("manual-password-123");
  const stagedChooser = page.waitForEvent("filechooser");
  await staged.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (
    await stagedChooser
  ).setFiles({
    name: "staged.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,DOB\nStaged Student,2009-02-01"),
  });
  await staged.getByText("1 account ready to import").waitFor();
  const second = await context.newPage();
  await second.goto(page.url());
  await second.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const secondDialog = second.getByRole("dialog", { name: "Account Creation", exact: true });
  const secondChooser = second.waitForEvent("filechooser");
  await secondDialog.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (
    await secondChooser
  ).setFiles({
    name: "second.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,DOB\nSecond Student,2009-02-01"),
  });
  await secondDialog.getByText("1 account ready to import").waitFor();
  loseImportReceipt = true;
  await secondDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await secondDialog.getByRole("button", { name: "Download login details", exact: true }).waitFor();
  const beforeManual = writes.filter((write) => write.path === "/api/v1/admin/users").length;
  await staged.getByRole("button", { name: "Save changes", exact: true }).click();
  assert.equal(
    writes.filter((write) => write.path === "/api/v1/admin/users").length,
    beforeManual,
    "Staged CSV never sends the manual fields",
  );
  await staged.getByRole("button", { name: "Download login details", exact: true }).waitFor();
  const stagedDownload = page.waitForEvent("download");
  await staged.getByRole("button", { name: "Download login details" }).click();
  assert.ok(
    (await readFile(await (await stagedDownload).path(), "utf8")).includes('"Second Student"'),
  );
  await staged.getByRole("button", { name: "Done" }).click();
  await staged.waitFor({ state: "detached" });
  await second.close();
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const uncertainImport = page.getByRole("dialog", { name: "Account Creation", exact: true });
  const chooserAfterLoss = page.waitForEvent("filechooser");
  await uncertainImport.getByRole("button", { name: "Upload CSV", exact: true }).click();
  await (
    await chooserAfterLoss
  ).setFiles({
    name: "uncertain-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,DOB\nRecovery Student,2009-02-01"),
  });
  await uncertainImport.getByText("1 account ready to import.", { exact: true }).waitFor();
  const importCount = () => writes.filter((write) => isBulkCreate(write.path)).length;
  const beforeLoss = importCount();
  const observer = await context.newPage();
  await observer.goto(page.url());
  await observer.getByRole("button", { name: "Add Accounts", exact: true }).waitFor();
  let unconfirmedDownloads = 0;
  page.on("download", () => {
    unconfirmedDownloads++;
  });
  loseImportReceipt = true;
  const saveImport = uncertainImport.getByRole("button", { name: "Save changes", exact: true });
  await page.route("**/bulk-imports/*/receipt", (route) => route.abort());
  await saveImport.click();
  const retryStatus = uncertainImport;
  await retryStatus
    .getByText("We couldn't verify which accounts were created from this CSV.", { exact: true })
    .waitFor();
  await retryStatus.getByRole("button", { name: "Check again", exact: true }).waitFor();
  await page.unroute("**/bulk-imports/*/receipt");
  await retryStatus.getByRole("button", { name: "Check again" }).click();
  await uncertainImport
    .getByRole("button", { name: "Download login details", exact: true })
    .waitFor();
  assert.equal(await saveImport.count(), 0, "An uncertain import must only offer receipt recovery");
  assert.equal(
    unconfirmedDownloads,
    0,
    "An uncertain import must not offer unverified credentials",
  );
  const durableValues = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("spatia.bulk-import:"))
      .map(([, value]) => value),
  );
  assert.equal(durableValues.length, 1);
  assert.match(durableValues[0], /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(
    writes.filter((write) => isBulkCreate(write.path)).at(-1).path,
    `${bulkImportsPath}/${durableValues[0]}`,
  );
  assert.equal(
    importCount(),
    beforeLoss + 1,
    "A lost bulk receipt must not discard an import by replaying it",
  );
  await observer.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const elsewhere = observer.getByRole("dialog", { name: "Account Creation" });
  await elsewhere.getByRole("button", { name: "Download login details", exact: true }).waitFor();
  const freshProfile = await browser.newContext();
  await freshProfile.route("**/api/v1/**", serveApi);
  const freshPage = await freshProfile.newPage();
  await freshPage.goto(page.url());
  await freshPage.getByRole("button", { name: "Add Accounts", exact: true }).click();
  await freshPage.getByLabel("Name", { exact: true }).fill("Manual entry is independent");
  assert.equal(await freshPage.getByText("Previous imports", { exact: true }).count(), 0);
  await freshProfile.close();
  assert.equal(importCount(), beforeLoss + 1);
  await page.reload();
  await page.getByRole("button", { name: "Add Accounts", exact: true }).click();
  const recovered = page.getByRole("dialog", { name: "Account Creation", exact: true });
  await recovered.getByRole("button", { name: "Download login details", exact: true }).waitFor();
  assert.equal(unconfirmedDownloads, 0, "No file is offered before server confirmation");
  const recoveredDownload = page.waitForEvent("download");
  await recovered.getByRole("button", { name: "Download login details", exact: true }).click();
  const recoveredFile = await recoveredDownload;
  const recoveredText = await readFile(await recoveredFile.path(), "utf8");
  assert.ok(recoveredText.includes('"Recovery Student"'));
  assert.ok(
    recoveredText.includes(
      writes
        .filter((entry) => isBulkCreate(entry.path))
        .at(-1)
        .body.at(-1).initialPassword,
    ),
    "The recovered credential matches the original",
  );
  assert.equal(importCount(), beforeLoss + 1);
  await recovered.getByRole("button", { name: "Done" }).click();
  await recovered.waitFor({ state: "detached" });
  await elsewhere.waitFor({ state: "detached" });
  await observer.close();
  await page
    .getByRole("button", { name: "View account for Recovery Student", exact: true })
    .waitFor();
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  assert.ok(!storage.includes("password1") && !storage.includes("password2"));
  for (const attempt of writes.filter((write) => isBulkCreate(write.path)))
    for (const value of attempt.body) assert.ok(!storage.includes(value.initialPassword));
  assert.equal(
    unconfirmedDownloads,
    1,
    "Only the explicitly requested recovered file was downloaded",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Account directory browser checks passed: create, override, errors, reload, filters, lifecycle, mobile, return navigation, failed-load recovery and sound.",
  );
} finally {
  await browser.close();
  await server?.close();
}
