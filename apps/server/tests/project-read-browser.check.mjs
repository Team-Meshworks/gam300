import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const accounts = JSON.parse(process.argv[3]);
const manager = JSON.parse(process.argv[4]);
const origin = target.origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "../../web/node_modules/playwright/index.mjs");
const browser = await chromium.launch();
process.stdout.write(`node ${process.version}; chromium ${browser.version()}\n`);
try {
  const openPage = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) { await route.abort(); return; }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(origin + "/_test/browser");
    return page;
  };
  const page = await openPage();
  const flow = await page.evaluate(async ({ accounts, manager }) => {
    const get = async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
    };
    const post = async (path, body) => {
      const csrf = (await (await fetch("/api/auth/csrf")).json()).requestToken;
      return (await fetch(path, { method: "POST", headers: {
        "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
      }, ...(body ? { body: JSON.stringify(body) } : {}) })).status;
    };
    const anonymous = await get("/api/projects");
    const sessions = [];
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      const login = await post("/api/auth/login", { userName: account.userName, password: "Synthetic-long-password1!" });
      sessions.push({ login, list: await get("/api/projects"), open: await get("/api/projects/" + account.projectId),
        denied: await get("/api/projects/" + accounts[1 - index].projectId),
        grants: await get("/api/projects/" + account.projectId + "/assignments") });
    }
    const managerLogin = await post("/api/auth/login", { userName: manager.userName, password: "Synthetic-long-password1!" });
    const grants = await get("/api/projects/" + accounts[0].projectId + "/assignments");
    const logout = await post("/api/auth/logout");
    return { anonymous, sessions, managerLogin, grants, logout,
      afterLogout: await get("/api/projects/" + accounts[1].projectId),
      grantsAfterLogout: await get("/api/projects/" + accounts[0].projectId + "/assignments") };
  }, { accounts, manager });
  assert.equal(flow.anonymous.status, 401);
  for (const [index, session] of flow.sessions.entries()) {
    assert.equal(session.login, 204);
    assert.equal(session.list.status, 200);
    assert.equal(session.list.cache, "no-store");
    assert.deepEqual(session.list.body.items.map((item) => item.projectId), [accounts[index].projectId]);
    assert.equal(session.list.body.nextCursor, null);
    assert.equal(session.open.status, 200);
    assert.equal(session.open.cache, "no-store");
    assert.deepEqual(Object.keys(session.open.body).sort(), ["document", "permissions", "projectId", "revision", "updatedAt"]);
    assert.equal(session.open.body.projectId, accounts[index].projectId);
    assert.equal(session.open.body.revision, 7);
    assert.equal(session.open.body.document.projectId, accounts[index].projectId.toUpperCase());
    assert.equal(session.open.body.document.schemaVersion, 1);
    assert.ok(session.open.body.document.scenes[0].objects.length > 0);
    assert.deepEqual(session.open.body.permissions, { canEdit: true, canManage: false, canPublish: false });
    assert.equal(session.denied.status, 404);
    assert.equal(session.denied.body.code, "project_not_found");
    assert.equal(Object.hasOwn(session.denied.body, "document"), false);
    assert.equal(session.grants.status, 403);
    assert.equal(session.grants.body.code, "access_denied");
    assert.equal(Object.hasOwn(session.grants.body, "assignments"), false);
  }
  assert.equal(flow.managerLogin, 204);
  assert.equal(flow.grants.status, 200);
  assert.equal(flow.grants.cache, "no-store");
  assert.deepEqual(flow.grants.body, {
    projectId: accounts[0].projectId,
    organizationId: manager.organizationId,
    revision: 7,
    archived: false,
    assignments: [
      { userId: accounts[0].userId, canEdit: true, canManage: false, canPublish: false },
      { userId: manager.userId, canEdit: true, canManage: true, canPublish: true },
    ].sort((left, right) => left.userId.localeCompare(right.userId)),
  });
  assert.equal(flow.logout, 204);
  assert.equal(flow.afterLogout.status, 401);
  assert.equal(flow.grantsAfterLogout.status, 401);

  const fresh = await openPage();
  const reopened = await fresh.evaluate(async (account) => {
    const absent = await fetch("/api/projects/" + account.projectId);
    const csrf = (await (await fetch("/api/auth/csrf")).json()).requestToken;
    const login = await fetch("/api/auth/login", { method: "POST", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
    }, body: JSON.stringify({ userName: account.userName, password: "Synthetic-long-password1!" }) });
    const open = await fetch("/api/projects/" + account.projectId);
    return { absent: absent.status, login: login.status, open: open.status, body: await open.json() };
  }, accounts[0]);
  assert.equal(reopened.absent, 401);
  assert.equal(reopened.login, 204);
  assert.equal(reopened.open, 200);
  assert.deepEqual(reopened.body, flow.sessions[0].open.body);
  process.stdout.write("browser project list/open/session switch passed\n");
} finally {
  await browser.close();
}
