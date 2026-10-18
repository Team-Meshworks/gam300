import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const origin = target.origin;
const administratorName = process.argv[3];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "../../web/node_modules/playwright/index.mjs");
const browser = await chromium.launch();
process.stdout.write(`node ${process.version}; chromium ${browser.version()}\n`);
try {
  const makeContext = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) { await route.abort(); return; }
      await route.continue();
    });
    return context;
  };
  const context = await makeContext();
  const page = await context.newPage();
  await page.goto(origin + "/_test/browser");
  const administration = await page.evaluate(async (userName) => {
    const token = async () => (await (await fetch("/api/auth/csrf")).json()).requestToken;
    const post = async (path, body, csrf) => fetch(path, { method: "POST", credentials: "same-origin", headers: {
      "Content-Type": "application/json", ...(csrf ? { "X-CSRF-TOKEN": csrf } : {}),
    }, body: JSON.stringify(body) });
    const credentials = { userName, password: "Synthetic-long-password1!" };
    const anonymousToken = await token();
    const missing = await post("/api/auth/login", credentials);
    const login = await post("/api/auth/login", credentials, anonymousToken);
    const initial = await (await fetch("/api/auth/session")).json();
    const stale = await post("/api/auth/password", { currentPassword: credentials.password,
      newPassword: "Browser administrator password 2!" }, anonymousToken);
    const forcedSwitch = await post("/api/auth/login", credentials, await token());
    const changed = await post("/api/auth/password", { currentPassword: credentials.password,
      newPassword: "Browser administrator password 2!" }, await token());
    const org = await post("/api/admin/organizations", { name: "Browser organization" }, await token());
    const organization = await org.json();
    const account = await post("/api/admin/users", { userName: "browser-created-" + crypto.randomUUID(),
      initialPassword: "Browser initial password 3!", role: "Creator", orgId: organization.id }, await token());
    const created = await account.json();
    return { missing: missing.status, login: login.status, initiallyForced: initial.mustChangePassword === true,
      stale: stale.status, forcedSwitch: forcedSwitch.status, changed: changed.status,
      organizationStatus: org.status, accountStatus: account.status, userName: created.userName, userId: created.userId,
      orgId: organization.id, cookiesHidden: document.cookie === "", metadataIsSafe: created.role === "Creator"
        && created.mustChangePassword === true && !Object.hasOwn(created, "initialPassword") && !Object.hasOwn(created, "passwordHash") };
  }, administratorName);
  assert.equal(administration.missing, 400);
  assert.equal(administration.login, 204);
  assert.equal(administration.initiallyForced, true);
  assert.equal(administration.stale, 400);
  assert.equal(administration.forcedSwitch, 403);
  assert.equal(administration.changed, 204);
  assert.equal(administration.organizationStatus, 201);
  assert.equal(administration.accountStatus, 201);
  assert.equal(administration.metadataIsSafe, true);
  assert.equal(administration.cookiesHidden, true);
  for (const name of ["__Host-Spatia.Application", "__Host-Spatia.Antiforgery"]) {
    const cookie = (await context.cookies()).find((entry) => entry.name === name);
    assert.equal(Boolean(cookie), true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
  }
  const targetContext = await makeContext();
  const targetPage = await targetContext.newPage();
  await targetPage.goto(origin + "/_test/browser");
  const initialTarget = await targetPage.evaluate(async ({ userName, orgId }) => {
    const csrf = (await (await fetch("/api/auth/csrf")).json()).requestToken;
    const login = await fetch("/api/auth/login", { method: "POST", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
    }, body: JSON.stringify({ userName, password: "Browser initial password 3!" }) });
    const response = await fetch("/api/auth/session");
    const session = await response.json();
    return { login: login.status, session: response.status, correctMetadata: session.role === "Creator"
      && session.orgId === orgId && session.mustChangePassword === true };
  }, administration);
  assert.equal(initialTarget.login, 204);
  assert.equal(initialTarget.session, 200);
  assert.equal(initialTarget.correctMetadata, true);
  const reset = await page.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/auth/csrf")).json()).requestToken;
    return (await fetch("/api/admin/users/" + id + "/password", { method: "POST", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
    }, body: JSON.stringify({ newTemporaryPassword: "Browser reset password 4!" }) })).status;
  }, administration.userId);
  assert.equal(reset, 204);
  const lifecycle = await targetPage.evaluate(async ({ userName, administratorName }) => {
    const token = async () => (await (await fetch("/api/auth/csrf")).json()).requestToken;
    const post = async (path, body, csrf) => fetch(path, { method: "POST", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const staleSession = await fetch("/api/auth/session");
    const resetLogin = await post("/api/auth/login", { userName, password: "Browser reset password 4!" }, await token());
    const changed = await post("/api/auth/password", { currentPassword: "Browser reset password 4!",
      newPassword: "Browser permanent password 5!" }, await token());
    const currentToken = await token();
    const write = await post("/_test/write", { value: "synthetic browser request" }, currentToken);
    const logout = await post("/api/auth/logout", null, currentToken);
    const absent = await fetch("/api/auth/session");
    const oldToken = await post("/api/auth/login", { userName, password: "Browser permanent password 5!" }, currentToken);
    const login = await post("/api/auth/login", { userName, password: "Browser permanent password 5!" }, await token());
    const switched = await post("/api/auth/login", { userName: administratorName,
      password: "Browser administrator password 2!" }, await token());
    const session = await (await fetch("/api/auth/session")).json();
    return { staleSession: staleSession.status, resetLogin: resetLogin.status, changed: changed.status, write: write.status,
      logout: logout.status, absent: absent.status, oldToken: oldToken.status, login: login.status, switched: switched.status,
      switchedToAdministrator: session.role === "Administrator", cookiesHidden: document.cookie === "" };
  }, { userName: administration.userName, administratorName });
  assert.equal(lifecycle.staleSession, 401);
  assert.equal(lifecycle.resetLogin, 204);
  assert.equal(lifecycle.changed, 204);
  assert.equal(lifecycle.write, 204);
  assert.equal(lifecycle.logout, 204);
  assert.equal(lifecycle.absent, 401);
  assert.equal(lifecycle.oldToken, 400);
  assert.equal(lifecycle.login, 204);
  assert.equal(lifecycle.switched, 204);
  assert.equal(lifecycle.switchedToAdministrator, true);
  assert.equal(lifecycle.cookiesHidden, true);
  await targetContext.close();
  await context.close();
  process.stdout.write("browser administration boundary passed\n");
  process.stdout.write("browser csrf boundary passed\n");
  process.stdout.write("browser session lifecycle passed\n");
} finally {
  await browser.close();
}
