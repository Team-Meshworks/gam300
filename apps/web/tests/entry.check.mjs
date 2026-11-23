import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const origin = process.argv[2] ?? "http://127.0.0.1:5181";
const browser = await launchBrowser({
  target: origin,
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
  const withoutSegmenter = await browser.newPage();
  await withoutSegmenter.addInitScript(() => {
    Intl.Segmenter = undefined;
  });
  let fallbackSession = null;
  await withoutSegmenter.route("**/api/v1/auth/session", (route) =>
    route.fulfill(fallbackSession ? { json: fallbackSession } : { status: 401 }),
  );
  await withoutSegmenter.route("**/api/v1/projects", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await withoutSegmenter.route("**/api/v1/classes", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await withoutSegmenter.goto(origin + "/");
  await withoutSegmenter.getByRole("heading", { name: "Welcome back." }).waitFor({ timeout: 5000 });
  assert.equal(await withoutSegmenter.getByLabel("Username", { exact: true }).isVisible(), true);
  fallbackSession = { ...session, role: "Creator", displayName: "😀 Creator" };
  await withoutSegmenter.goto(origin + "/home");
  await withoutSegmenter.getByText("😀 Creator", { exact: true }).waitFor();
  assert.equal(await withoutSegmenter.locator(".sp-header-account .sp-avatar").textContent(), "😀");
  await withoutSegmenter.close();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "anonymous";
  let role = session.role;
  let loginRequests = 0;
  let passwordRequests = 0;
  let releaseLogin;
  let pendingLogin;
  let loginStarted;
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/csrf") {
      if (mode === "unavailable")
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html>Unavailable</html>",
        });
      return route.fulfill({
        status: 200,
        json: { requestToken: "browser-test-token" },
      });
    }
    if (path === "/api/v1/auth/session" && mode === "unavailable")
      return route.fulfill({ status: 503 });
    if (path === "/api/v1/auth/session")
      return mode === "signed-in" || mode === "forced"
        ? route.fulfill({
            status: 200,
            json: {
              ...session,
              role,
              orgId: role === "Administrator" ? null : session.orgId,
              mustChangePassword: mode === "forced",
            },
          })
        : route.fulfill({ status: 401 });
    if (path === "/api/v1/auth/login") {
      loginRequests += 1;
      loginStarted?.();
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
    if (path === "/api/v1/auth/logout") {
      assert.equal(request.headers()["x-spatia-account"], session.userId);
      assert.equal(request.headers()["x-csrf-token"], "browser-test-token");
      mode = "anonymous";
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/auth/password") {
      passwordRequests += 1;
      assert.equal(request.headers()["x-spatia-account"], session.userId);
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

  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/api/v1/classes", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto(origin + "/");
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal(await page.getByLabel("Username", { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel("Password", { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("heading", { name: "Spatia", exact: true }).count(), 0);

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
        .getByRole("heading", {
          name: path === "/login" ? "Welcome back." : /Build immersive/i,
        })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, path);
      await page.reload();
      await page
        .getByRole("heading", {
          name: path === "/login" ? "Welcome back." : /Build immersive/i,
        })
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
  // The link waits a moment so its sound can start before the page changes
  await page.waitForURL("**/landing");
  assert.equal(new URL(page.url()).pathname, "/landing");
  await page
    .getByRole("link", { name: /start a classroom/i })
    .first()
    .click();
  assert.equal(new URL(page.url()).pathname, "/login");

  const help = page.getByRole("button", { name: "Need help signing in?" });
  await help.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Account help" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await help.evaluate((node) => node === document.activeElement), true);
  const username = page.getByLabel("Username", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await username.focus();
  await page.keyboard.type("teacher");
  await page.keyboard.press("Tab");
  assert.equal(await password.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.type("incorrect password");
  await page.getByRole("button", { name: /show password/i }).click();
  assert.equal(await password.getAttribute("type"), "text");
  await page.getByRole("button", { name: /hide password/i }).click();
  assert.equal(await password.getAttribute("type"), "password");
  mode = "reject";
  pendingLogin = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  const submit = page.getByRole("button", { name: /log in/i });
  const receivedLogin = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Login request was not received")), 5000);
    loginStarted = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  await submit.click();
  await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
  await receivedLogin;
  loginStarted = undefined;
  assert.equal(loginRequests, 1);
  releaseLogin();
  pendingLogin = undefined;
  await page.getByText(/username or password could not be accepted/i).waitFor();
  assert.equal(loginRequests, 1);
  assert.equal(
    await page.getByRole("alert").evaluate((node) => node === document.activeElement),
    true,
  );
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
  assert.equal(
    await page
      .getByRole("heading", { name: "Change your password." })
      .evaluate((node) => node === document.activeElement),
    true,
  );
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
  await page.waitForURL(`${origin}/home`);
  assert.equal(await page.getByLabel("Username", { exact: true }).count(), 0);
  await page.reload();
  await page.waitForURL(`${origin}/home`);
  await page.getByRole("button", { name: "Log Out" }).click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await username.fill("teacher");
  await password.fill("incorrect password");
  await submit.click();
  await page.waitForURL(`${origin}/home`);
  assert.equal(await page.getByLabel("Username", { exact: true }).count(), 0);
  // A publication link survives authentication and the mandatory password step.
  const publication = "/p/7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
  for (const role of ["Administrator", "Educator", "Creator"]) {
    const visitorPage = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    let visitorSession = null;
    let forcePassword = role === "Creator";
    await visitorPage.route("**/api/v1/auth/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/auth/csrf") return route.fulfill({ json: { requestToken: "test" } });
      if (path === "/api/v1/auth/session")
        return visitorSession
          ? route.fulfill({ json: visitorSession })
          : route.fulfill({ status: 401 });
      if (path === "/api/v1/auth/login") {
        visitorSession = {
          ...session,
          role,
          orgId: role === "Administrator" ? null : session.orgId,
          mustChangePassword: forcePassword,
        };
        return route.fulfill({ status: 204 });
      }
      if (path === "/api/v1/auth/password") {
        forcePassword = false;
        visitorSession = { ...visitorSession, mustChangePassword: false };
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ status: 404 });
    });
    await visitorPage.route(`**${publication}`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Publication destination</h1>",
      }),
    );
    await visitorPage.goto(`${origin}/login?returnTo=${encodeURIComponent(publication)}`);
    await visitorPage.getByLabel("Username", { exact: true }).fill("teacher");
    await visitorPage.getByLabel("Password", { exact: true }).fill("incorrect password");
    await visitorPage.getByLabel("Password", { exact: true }).press("Enter");
    if (forcePassword) {
      await visitorPage.getByRole("heading", { name: "Change your password." }).waitFor();
      assert.equal(new URL(visitorPage.url()).pathname, "/login");
      await visitorPage.reload();
      await visitorPage.getByRole("heading", { name: "Change your password." }).waitFor();
      await visitorPage.getByLabel("Current password").fill("incorrect password");
      await visitorPage.getByLabel("New password", { exact: true }).fill("a different password");
      await visitorPage.getByLabel("Confirm new password").fill("a different password");
      await visitorPage.getByRole("button", { name: "Change password" }).click();
    }
    await visitorPage.waitForURL(`${origin}${publication}`, { timeout: 5000 });
    await visitorPage.getByRole("heading", { name: "Publication destination" }).waitFor();
    await visitorPage.close();
  }
  for (const role of ["Educator", "Creator"]) {
    const rolePage = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await rolePage.route("**/api/v1/auth/session", (route) =>
      route.fulfill({ json: { ...session, role } }),
    );
    await rolePage.route("**/home", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Project home</h1>",
      }),
    );
    await rolePage.addInitScript(() => {
      if (location.pathname !== "/login") return;
      sessionStorage.removeItem("signed-in-flash");
      new MutationObserver(() => {
        if (
          /Signed in as|Go to projects|Opening your projects|Opening your dashboard/.test(
            document.body?.innerText ?? "",
          )
        )
          sessionStorage.setItem("signed-in-flash", "1");
      }).observe(document, { childList: true, subtree: true });
    });
    await rolePage.goto(`${origin}/login`);
    await rolePage.waitForURL(`${origin}/home`);
    await rolePage.getByRole("heading", { name: "Project home" }).waitFor();
    assert.equal(
      await rolePage.evaluate(() => sessionStorage.getItem("signed-in-flash")),
      null,
      "Role redirects must not paint the old signed-in page",
    );
    await rolePage.close();
  }
  for (const query of [
    "returnTo=https%3A%2F%2Fevil.example%2Fp%2F7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
    "returnTo=%2F%2Fevil.example%2Fp%2F7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
    "returnTo=%2Fp%2Fnot-a-uuid",
    `returnTo=${encodeURIComponent(publication)}&returnTo=${encodeURIComponent(publication)}`,
  ]) {
    await page.goto(`${origin}/login?${query}`);
    await page.waitForURL(`${origin}/home`);
    assert.equal(new URL(page.url()).pathname, "/home");
  }
  mode = "reject";
  await page.goto(`${origin}/login?returnTo=${encodeURIComponent(publication)}`);
  await page.getByLabel("Username", { exact: true }).fill("teacher");
  await page.getByLabel("Password", { exact: true }).fill("incorrect password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByText(/username or password could not be accepted/i).waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  mode = "signed-in";
  await page.route(`**${publication}`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Publication destination</h1>",
    }),
  );
  await page.goto(`${origin}/login?returnTo=${encodeURIComponent(publication)}`);
  await page.waitForURL(`${origin}${publication}`);
  await page.getByRole("heading", { name: "Publication destination" }).waitFor();
  const racePage = await browser.newPage();
  let raceSignedIn = false;
  let releaseInitial;
  const initial = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  await racePage.route("**/api/v1/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session") {
      if (!raceSignedIn) {
        await initial;
        return route.fulfill({ status: 401 });
      }
      return route.fulfill({ status: 200, json: session });
    }
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({
        status: 200,
        json: { requestToken: "race-token" },
      });
    if (path === "/api/v1/auth/login") {
      raceSignedIn = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });
  await racePage.route("**/home", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Project home</h1>" }),
  );
  await racePage.goto(origin + "/login");
  await racePage.getByLabel("Username").fill("teacher");
  await racePage.getByLabel("Password", { exact: true }).fill("incorrect password");
  await racePage.getByRole("button", { name: "Log in" }).click();
  const initialResponse = racePage.waitForResponse(
    (response) => response.url().endsWith("/api/v1/auth/session") && response.status() === 401,
  );
  releaseInitial();
  await initialResponse;
  await racePage.waitForURL(`${origin}/home`);
  await racePage.getByRole("heading", { name: "Project home" }).waitFor();
  await racePage.close();
  for (const destination of ["/home", "/admin/dashboard"]) {
    await page.route(`**${destination}`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Account destination</h1>",
      }),
    );
  }
  for (const [accountRole, authenticated, forcePassword] of [
    ["Educator", false, false],
    ["Creator", true, false],
    ["Administrator", true, false],
    ["Creator", false, true],
  ]) {
    role = accountRole;
    mode = authenticated ? "signed-in" : forcePassword ? "next-forced" : "anonymous";
    const destination = role === "Administrator" ? "/admin/dashboard" : "/home";
    await page.goto(origin + "/login");
    if (!authenticated) {
      await page.getByLabel("Username", { exact: true }).fill("teacher");
      await page.getByLabel("Password", { exact: true }).fill("incorrect password");
      await page.getByRole("button", { name: "Log in" }).click();
    }
    if (forcePassword) {
      await page.getByRole("heading", { name: "Change your password." }).waitFor();
      assert.notEqual(new URL(page.url()).pathname, destination);
      await page.getByLabel("Current password").fill("incorrect password");
      await page.getByLabel("New password", { exact: true }).fill("a different password");
      await page.getByLabel("Confirm new password").fill("a different password");
      await page.getByRole("button", { name: "Change password" }).click();
    }
    await page.waitForURL(`${origin}${destination}`);
    await page.getByRole("heading", { name: "Account destination" }).waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(
    "Entry routes, responsive layout, navigation and rejected/unavailable sign-in checks passed.",
  );
} finally {
  await browser.close();
}
