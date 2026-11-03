import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ["--enable-unsafe-swiftshader"],
});
const session = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "Test Teacher",
  role: "Educator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  mustChangePassword: false,
};
const screens = [
  ["admin/dashboard", "Welcome Back, Test Teacher"],
  ["new-project", "New Project"],
  ["classes", "Class assignments"],
  ["review", "Submission review"],
  ["accounts", "Accounts"],
];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "Educator";
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    assert.equal(request.method(), "GET", "Workspace routes must not mutate the API");
    if (new URL(request.url()).pathname === "/api/auth/session") {
      if (mode === "anonymous") return route.fulfill({ status: 401 });
      if (mode === "unavailable") return route.fulfill({ status: 503 });
      return route.fulfill({
        status: 200,
        json: {
          ...session,
          role: mode === "forced" ? "Educator" : mode,
          orgId: mode === "Administrator" ? null : session.orgId,
          mustChangePassword: mode === "forced",
        },
      });
    }
    return route.fulfill({ status: 503 });
  });

  async function screen(path, heading) {
    await page.goto(`${origin}/${path}`);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.equal(await page.getByText(/development preview|simulation|ms tan/i).count(), 0);
  }
  for (const [path, heading] of screens) {
    mode = path === "accounts" || path === "admin/dashboard" ? "Administrator" : "Educator";
    await screen(`${path}/?source=check`, heading);
    await page.reload();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  }

  mode = "Educator";
  await screen("new-project", "New Project");
  const title = page.getByLabel("Project title");
  await title.fill("A project title");
  assert.equal(await title.inputValue(), "A project title");
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  assert.ok(await fileChooser, "Gallery opens the cover image picker");
  assert.equal(await page.getByRole("button", { name: "Create project" }).isDisabled(), true);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Workspace fits viewport at ${width}px`,
    );
    assert.equal(await page.getByRole("navigation", { name: "Workspace screens" }).count(), 1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await screen("classes", "Class assignments");
  await page.getByRole("link", { name: /new project/i }).click();
  await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/new-project");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Class assignments", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/classes");
  await page.getByRole("link", { name: "Submission review", exact: true }).click();
  await page.getByRole("heading", { name: "Submission review", exact: true }).waitFor();
  await page.getByRole("link", { name: /new project/i }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Submission review", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/review");
  await page.goBack();
  await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
  await page.goForward();
  await page.getByRole("heading", { name: "Submission review", exact: true }).waitFor();
  await screen("new-project", "New Project");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Class assignments", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/classes");
  await screen("new-project?from=https%3A%2F%2Fevil.example", "New Project");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Class assignments", exact: true }).waitFor();
  assert.equal(page.url(), `${origin}/classes`);

  for (const path of ["classes", "review", "accounts", "admin/dashboard"]) {
    mode = "Creator";
    await page.goto(`${origin}/${path}`);
    await page
      .getByText(/not authorized|not authorised|access denied|do not have access/i)
      .first()
      .waitFor();
    const heading = screens.find(([name]) => name === path)[1];
    assert.equal(await page.getByRole("heading", { name: heading, exact: true }).count(), 0);
  }
  mode = "anonymous";
  await page.goto(`${origin}/classes`);
  await page
    .getByRole("link", { name: /log in|sign in/i })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Class assignments", exact: true }).count(),
    0,
  );
  mode = "unavailable";
  await page.goto(`${origin}/classes`);
  await page
    .getByText(/unavailable|try again/i)
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Class assignments", exact: true }).count(),
    0,
  );
  mode = "forced";
  await page.goto(`${origin}/classes`);
  await page
    .getByText(/change.*password|password.*change/i)
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Class assignments", exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log("Workspace route browser checks passed");
} finally {
  await browser.close();
}
