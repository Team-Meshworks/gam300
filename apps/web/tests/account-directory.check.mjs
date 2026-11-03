import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = process.argv[2]
  ? null
  : await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server?.listen();
const origin = process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const rows = [];
const writes = [];
let duplicate = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          userId,
          displayName: "VThere",
          role: "Administrator",
          orgId: null,
          mustChangePassword: false,
        },
      });
    if (path === "/api/auth/csrf") return route.fulfill({ json: { requestToken: "test-csrf" } });
    if (req.method() !== "GET") {
      assert.equal(req.headers()["x-csrf-token"], "test-csrf");
      const body = req.postDataJSON();
      writes.push({ path, body });
      if (duplicate) return route.fulfill({ status: 409, json: { code: "username_taken" } });
      await new Promise((resolve) => setTimeout(resolve, 200));
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
    if (path === "/api/admin/organizations")
      return route.fulfill({
        json: {
          items: [{ id: orgId, name: "Ridgeview Secondary School", isActive: true }],
          nextCursor: null,
        },
      });
    if (path.endsWith("/projects"))
      return route.fulfill({
        json: {
          items: [
            { id: userId, title: "The Silk Road: A Journey Through History", status: "Draft" },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/admin/users")
      return route.fulfill({ json: { items: rows, nextCursor: null } });
    if (path === `/api/admin/users/${userId}`) return route.fulfill({ json: rows[0] });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/accounts`);
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.getByRole("button", { name: "+ Add Accounts", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Aisyah Abdullah");
  await dialog.getByLabel("Username", { exact: true }).fill("aisyah");
  await dialog.getByLabel("Password", { exact: true }).fill("Synthetic-password1!");
  await dialog.getByRole("button", { name: "Show password", exact: true }).click();
  assert.equal(await dialog.getByLabel("Password", { exact: true }).getAttribute("type"), "text");
  const screenshots = "../../.artifacts/account-directory";
  await mkdir(screenshots, { recursive: true });
  await dialog.getByRole("button", { name: "Hide password", exact: true }).click();
  await page.screenshot({ path: `${screenshots}/create-account.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Save changes" }).evaluate((button) => {
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
  await dialog.getByLabel("Account Type", { exact: true }).selectOption("Educator");
  await dialog.getByRole("button", { name: "Override password", exact: true }).click();
  await dialog.getByLabel("New password", { exact: true }).fill("Replacement-password2!");
  await dialog.getByRole("button", { name: "Save changes" }).click();
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
  await page.screenshot({ path: `${screenshots}/directory.png`, fullPage: true });
  await page.getByRole("button", { name: "Disable account for Aisyah Tan" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Enable account for Aisyah Tan" }).waitFor();
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
  await page.getByRole("button", { name: "All organisations", exact: true }).click();
  assert.equal(
    await page.getByRole("heading", { name: "Organisations", exact: true }).isVisible(),
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
  rows[0].displayName = "Aisyah Refreshed";
  await page.getByRole("button", { name: "Open Ridgeview Secondary School" }).click();
  await page.getByRole("button", { name: "View account for Aisyah Refreshed" }).waitFor();
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  assert.ok(!storage.includes("password1") && !storage.includes("password2"));
  assert.deepEqual(errors, []);
  console.log(
    "Account directory browser checks passed: create, override, errors, reload, filters, lifecycle, mobile, return navigation and sound.",
  );
} finally {
  await browser.close();
  await server?.close();
}
