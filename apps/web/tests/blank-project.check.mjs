import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const projectId = "aefea67c-caca-4300-923c-937f1c785578";
const session = {
  userId,
  orgId,
  displayName: "Teacher",
  mustChangePassword: false,
};

try {
  for (const [role, assetsStatus] of [
    ["Educator", 200],
    ["Creator", 200],
    ["Educator", 503],
  ]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const writes = [];
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/auth/session") return route.fulfill({ json: { ...session, role } });
      if (path === "/api/v1/auth/csrf")
        return route.fulfill({ json: { requestToken: "test-token" } });
      if (path === "/api/v1/assets")
        return assetsStatus === 200 ? route.fulfill({ json: [] }) : route.fulfill({ status: 503 });
      if (path === "/api/v1/projects" && request.method() === "GET")
        return route.fulfill({ json: { items: [], nextCursor: null } });
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
    const assetsLoaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/assets",
    );
    await page.goto(origin + "/home");
    await assetsLoaded.catch(async (error) => {
      throw new Error(`Assets request did not occur: ${await page.locator("body").innerText()}`, {
        cause: error,
      });
    });
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
