import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
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
const screenshots = "../../.artifacts/ui-foundation/entry-check";
await mkdir(screenshots, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "anonymous";
  let loginRequests = 0;
  let passwordRequests = 0;
  let releaseLogin;
  let pendingLogin;
  await page.route("**/api/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/csrf") {
      if (mode === "unavailable")
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html>Unavailable</html>",
        });
      return route.fulfill({ status: 200, json: { requestToken: "browser-test-token" } });
    }
    if (path === "/api/auth/session" && mode === "unavailable")
      return route.fulfill({ status: 503 });
    if (path === "/api/auth/session")
      return mode === "signed-in" || mode === "forced"
        ? route.fulfill({
            status: 200,
            json: { ...session, mustChangePassword: mode === "forced" },
          })
        : route.fulfill({ status: 401 });
    if (path === "/api/auth/login") {
      loginRequests += 1;
      assert.equal(request.headers()["x-csrf-token"], "browser-test-token");
      assert.deepEqual(request.postDataJSON(), {
        userName: "teacher",
        password: "incorrect password",
      });
      if (pendingLogin) await pendingLogin;
      if (mode === "reject") return route.fulfill({ status: 401 });
      mode = mode === "next-forced" ? "forced" : "signed-in";
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/auth/logout") {
      assert.equal(request.headers()["x-csrf-token"], "browser-test-token");
      mode = "anonymous";
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/auth/password") {
      passwordRequests += 1;
      assert.equal(request.headers()["x-csrf-token"], "browser-test-token");
      assert.deepEqual(request.postDataJSON(), {
        currentPassword: "incorrect password",
        newPassword: "a different password",
      });
      mode = "signed-in";
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });

  mode = "unavailable";
  await page.goto(origin + "/login");
  await page
    .getByRole("alert")
    .getByText(/account service is unavailable/i)
    .waitFor();
  mode = "anonymous";

  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/landing", "/login"]) {
      await page.goto(origin + path);
      await page
        .getByRole("heading", { name: path === "/login" ? "Welcome back." : /Build immersive/i })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, path);
      await page.reload();
      await page
        .getByRole("heading", { name: path === "/login" ? "Welcome back." : /Build immersive/i })
        .waitFor();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${path} overflows at ${width}px`,
      );
      if (path === "/landing") {
        for (const picture of await page.locator(".landing-exhibit-image img").all()) {
          await picture.scrollIntoViewIfNeeded();
          await picture.evaluate((image) => image.decode());
          assert.ok(
            await picture.evaluate((image) => image.naturalWidth > 0),
            "Gallery images load on scroll",
          );
        }
        await page.evaluate(() => scrollTo(0, 0));
      }
      await page.screenshot({
        path: `${screenshots}/${path.slice(1)}-${width}.png`,
        fullPage: true,
      });
    }
  }
  for (const path of ["/landing/", "/login/"]) {
    await page.goto(origin + path);
    await page
      .getByRole("heading", {
        name: path.startsWith("/login") ? "Welcome back." : /Build immersive/i,
      })
      .waitFor();
    await page.reload();
    await page
      .getByRole("heading", {
        name: path.startsWith("/login") ? "Welcome back." : /Build immersive/i,
      })
      .waitFor();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/landing");
  await page.getByRole("button", { name: "Preview exhibit" }).first().click();
  await page.getByRole("dialog", { name: /The Silk Road/ }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const getStarted = page.getByRole("link", { name: /get started/i }).first();
  await getStarted.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Welcome back.", exact: true }).waitFor();
  await page.getByRole("link", { name: /back to home/i }).click();
  assert.equal(new URL(page.url()).pathname, "/landing");
  await page
    .getByRole("link", { name: /start a classroom/i })
    .first()
    .click();
  assert.equal(new URL(page.url()).pathname, "/login");

  await page.getByRole("button", { name: "Need help signing in?" }).click();
  await page.getByRole("dialog", { name: "Account help" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const username = page.getByLabel("Username", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await username.fill("teacher");
  await password.fill("incorrect password");
  await page.getByRole("button", { name: /show password/i }).click();
  assert.equal(await password.getAttribute("type"), "text");
  await page.getByRole("button", { name: /hide password/i }).click();
  assert.equal(await password.getAttribute("type"), "password");
  mode = "reject";
  pendingLogin = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  const submit = page.getByRole("button", { name: /log in/i });
  await submit.click();
  await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
  assert.equal(loginRequests, 1);
  releaseLogin();
  pendingLogin = undefined;
  await page.getByText(/username or password could not be accepted/i).waitFor();
  assert.equal(await username.inputValue(), "teacher");
  assert.equal(await password.inputValue(), "");
  mode = "unavailable";
  await password.fill("incorrect password");
  await submit.click();
  await page.getByText(/account service is unavailable/i).waitFor();
  assert.equal(loginRequests, 1);
  mode = "next-forced";
  await password.fill("incorrect password");
  await submit.click();
  await page.getByRole("heading", { name: "Change your password." }).waitFor();
  assert.equal(await page.getByLabel("Username", { exact: true }).count(), 0);
  await page.getByLabel("Current password").fill("incorrect password");
  await page.getByLabel("New password", { exact: true }).fill("a different password");
  await page.getByLabel("Confirm new password").fill("wrong confirmation");
  await page.getByRole("button", { name: "Change password" }).click();
  await page
    .getByRole("alert")
    .getByText(/enter the same new password twice/i)
    .waitFor();
  assert.equal(passwordRequests, 0);
  await page.getByLabel("Confirm new password").fill("a different password");
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("heading", { name: /You.re signed in/ }).waitFor();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: "Signed in as Test Teacher · Educator" })
      .isVisible(),
    true,
  );
  await page.reload();
  await page.getByRole("heading", { name: /You.re signed in/ }).waitFor();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await username.fill("teacher");
  await password.fill("incorrect password");
  await submit.click();
  await page.getByRole("heading", { name: /You.re signed in/ }).waitFor();
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: "Signed in as Test Teacher · Educator" })
      .isVisible(),
    true,
  );
  const racePage = await browser.newPage();
  let raceSignedIn = false;
  let releaseInitial;
  const initial = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  await racePage.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      if (!raceSignedIn) {
        await initial;
        return route.fulfill({ status: 401 });
      }
      return route.fulfill({ status: 200, json: session });
    }
    if (path === "/api/auth/csrf")
      return route.fulfill({ status: 200, json: { requestToken: "race-token" } });
    if (path === "/api/auth/login") {
      raceSignedIn = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });
  await racePage.goto(origin + "/login");
  await racePage.getByLabel("Username").fill("teacher");
  await racePage.getByLabel("Password", { exact: true }).fill("incorrect password");
  await racePage.getByRole("button", { name: "Log in" }).click();
  await racePage.getByRole("heading", { name: /You.re signed in/ }).waitFor();
  const initialResponse = racePage.waitForResponse(
    (response) => response.url().endsWith("/api/auth/session") && response.status() === 401,
  );
  releaseInitial();
  await initialResponse;
  assert.equal(await racePage.getByRole("heading", { name: /You.re signed in/ }).isVisible(), true);
  await racePage.close();
  await page.goto(origin + "/");
  await page.getByRole("heading", { name: "Spatia", exact: true }).waitFor();
  // Allow the same renderer/model startup time as the editor browser suites.
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log(
    "Entry routes, responsive layout, navigation and rejected/unavailable sign-in checks passed.",
  );
} finally {
  await browser.close();
}
