import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { createServer } from "vite";

const oldPassword = "Synthetic-long-password1!";
const newPassword = "Synthetic-replacement-password2!";
const admin = process.env.SPATIA_TEST_ADMIN;
const creator = process.env.SPATIA_TEST_CREATOR;
assert.ok(admin && creator && process.env.SPATIA_API_ORIGIN, "Fixture configuration is required");
const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "silent" });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://127.0.0.1:${address.port}`;
  browser = await launchBrowser({ target: origin });
  async function context() {
    const result = await browser.newContext({ ignoreHTTPSErrors: true });
    await result.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      return route.continue();
    });
    return result;
  }
  async function login(page, username, password) {
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
  }
  async function session(page) {
    return page.evaluate(async () => {
      const response = await fetch("/api/v1/auth/session");
      return { status: response.status, body: response.ok ? await response.json() : null };
    });
  }
  const first = await context();
  const page = await first.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin + "/landing");
  await page
    .getByRole("link", { name: /get started/i })
    .first()
    .click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.getByRole("link", { name: /back to home/i }).click();
  // Back navigation waits briefly for its UI sound before leaving the page.
  await page.waitForURL(origin + "/landing");
  assert.equal(new URL(page.url()).pathname, "/landing");
  await page
    .getByRole("link", { name: /get started/i })
    .first()
    .click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await login(page, admin, "Synthetic-incorrect-password1!");
  await page.getByText(/username or password could not be accepted/i).waitFor();
  assert.equal((await session(page)).status, 401);
  await page.reload();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await login(page, admin, oldPassword);
  await page.getByRole("heading", { name: "Change your password." }).waitFor();
  assert.equal((await session(page)).body.mustChangePassword, true);
  await page.reload();
  await page.getByRole("heading", { name: "Change your password." }).waitFor();
  const cookies = await first.cookies(origin);
  for (const name of ["__Host-Spatia.Application", "__Host-Spatia.Antiforgery"]) {
    const cookie = cookies.find((item) => item.name === name);
    assert.ok(cookie, `Missing ${name} cookie`);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.path, "/");
  }
  assert.equal(
    await page.evaluate(
      async () => (await fetch("/api/v1/auth/logout", { method: "POST" })).status,
    ),
    400,
  );
  assert.equal((await session(page)).status, 200);
  await page.getByLabel("Current password").fill(oldPassword);
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  await page.getByRole("heading", { name: /^Welcome Back,/ }).waitFor();
  assert.equal((await session(page)).body.mustChangePassword, false);
  await page.reload();
  await page.getByRole("heading", { name: /^Welcome Back,/ }).waitFor();
  const browserStorage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookies: document.cookie,
    }),
  );
  assert.ok(!browserStorage.includes(oldPassword) && !browserStorage.includes(newPassword));
  assert.ok(!browserStorage.includes("__Host-Spatia.Application"));
  await page.getByRole("button", { name: "Log Out", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal((await session(page)).status, 401);
  await page.reload();
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  assert.equal((await session(page)).status, 401);
  await first.close();
  const fresh = await context();
  const next = await fresh.newPage();
  next.setDefaultTimeout(10000);
  await next.goto(origin + "/login");
  await login(next, admin, oldPassword);
  await next.getByText(/username or password could not be accepted/i).waitFor();
  await login(next, admin, newPassword);
  await next.waitForURL(origin + "/admin/dashboard");
  await next.getByRole("heading", { name: /^Welcome Back,/ }).waitFor();
  assert.equal((await session(next)).body.role, "Administrator");
  await fresh.close();
  const normalContext = await context();
  const normal = await normalContext.newPage();
  normal.setDefaultTimeout(10000);
  await normal.goto(origin + "/login");
  await login(normal, creator, oldPassword);
  await normal.getByRole("heading", { name: /You.re signed in/ }).waitFor();
  assert.equal((await session(normal)).body.role, "Creator");
  await normalContext.close();
  console.log("Real HTTPS login, password change, session and logout checks passed.");
} finally {
  await browser?.close();
  await server.close();
}
