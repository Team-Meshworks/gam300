import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const accounts = JSON.parse(process.argv[3]);
const origin = target.origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "../../web/node_modules/playwright/index.mjs");
// Bundle the actual editor coordinator into the existing authenticated browser fixture
// No alternate saver or mock API is involved in this cross-browser recovery check
const { build } =
  await import("../../web/node_modules/vite/dist/node/index.js");
const webRoot = fileURLToPath(new URL("../../web/", import.meta.url)).replaceAll("\\", "/");
const bundle = await build({
  configFile: false,
  root: webRoot,
  logLevel: "silent",
  plugins: [
    {
      name: "recovery-check-entry",
      resolveId(id) {
        if (id === "recovery-check" || id.endsWith("recovery-check"))
          return "\0recovery-check";
      },
      load(id) {
        if (id === "\0recovery-check")
          return `
      export { readServerProject } from "${webRoot}editor/persistence/server-project-read.ts";
      export { connectServerProjectSession } from "${webRoot}editor/persistence/server-project-session.ts";
      export { createDocumentStore } from "${webRoot}editor/document-store.ts";
    `;
      },
    },
  ],
  build: {
    write: false,
    lib: {
      entry: "recovery-check",
      name: "serverRecoveryTest",
      formats: ["iife"],
    },
  },
});
const browser = await chromium.launch();
process.stdout.write(`node ${process.version}; chromium ${browser.version()}\n`);
try {
  const openPage = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) { await route.abort(); return; }
      await route.continue();
    });
    await context.addInitScript({
      content:
        (Array.isArray(bundle) ? bundle[0] : bundle).output[0].code +
        ";globalThis.serverRecoveryTest = serverRecoveryTest;",
    });
    const page = await context.newPage();
    await page.goto(origin + "/_test/browser");
    return page;
  };
  const page = await openPage();
  const flow = await page.evaluate(async (accounts) => {
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
        denied: await get("/api/projects/" + accounts[1 - index].projectId) });
    }
    const logout = await post("/api/auth/logout");
    return { anonymous, sessions, logout, afterLogout: await get("/api/projects/" + accounts[1].projectId) };
  }, accounts);
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
  }
  assert.equal(flow.logout, 204);
  assert.equal(flow.afterLogout.status, 401);

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
  // Save through the real coordinator, then reopen from a separate authenticated browser
  const saved = await fresh.evaluate(async (projectId) => {
    const account = await (await fetch("/api/auth/session")).json();
    const assets = new Map([
      ["test-room-v1", "environment"],
      ["test-crate-v1", "model"],
    ]);
    const signal = new AbortController().signal;
    const opened = await serverRecoveryTest.readServerProject(
      projectId,
      account.userId,
      assets,
      signal,
    );
    if (!opened.ok) throw new Error("Coordinator could not open the project");
    const store = serverRecoveryTest.createDocumentStore([]);
    store.loadProject(JSON.stringify(opened.value.document), assets);
    const session = serverRecoveryTest.connectServerProjectSession({
      accountId: account.userId,
      store,
      revision: opened.value.revision,
      storageRevision: 0,
      assetKinds: assets,
      signal,
      onStatus() {},
    });
    store.loadProject(
      JSON.stringify({
        ...opened.value.document,
        title: "Confirmed browser autosave",
      }),
      assets,
    );
    const left = await session.prepareToLeave("save");
    return { left, status: session.getStatus() };
  }, accounts[0].projectId);
  assert.deepEqual(saved.left, { ok: true, value: true });
  assert.equal(saved.status, "saved");
  // A fresh browser reopens the server revision without the first browser cache
  const otherBrowser = await openPage();
  const independentlyOpened = await otherBrowser.evaluate(async (account) => {
    const token = (await (await fetch("/api/auth/csrf")).json()).requestToken;
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
      body: JSON.stringify({
        userName: account.userName,
        password: "Synthetic-long-password1!",
      }),
    });
    const identity = await (await fetch("/api/auth/session")).json();
    return serverRecoveryTest.readServerProject(
      account.projectId,
      identity.userId,
      new Map([
        ["test-room-v1", "environment"],
        ["test-crate-v1", "model"],
      ]),
      new AbortController().signal,
    );
  }, accounts[0]);
  assert.equal(independentlyOpened.ok, true);
  assert.equal(independentlyOpened.value.revision, 8);
  assert.equal(
    independentlyOpened.value.document.title,
    "Confirmed browser autosave",
  );
  // Advance the server independently, then prove the stale editor keeps its own draft
  const conflict = await otherBrowser.evaluate(async (opened) => {
    const assets = new Map([
      ["test-room-v1", "environment"],
      ["test-crate-v1", "model"],
    ]);
    const store = serverRecoveryTest.createDocumentStore([]);
    store.loadProject(JSON.stringify(opened.document), assets);
    const session = serverRecoveryTest.connectServerProjectSession({
      accountId: opened.accountId,
      store,
      revision: opened.revision,
      storageRevision: 0,
      assetKinds: assets,
      signal: new AbortController().signal,
      onStatus() {},
    });
    const token = (await (await fetch("/api/auth/csrf")).json()).requestToken;
    // A second writer advances the server before this stale editor saves
    const winner = await fetch("/api/projects/" + opened.document.projectId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
      body: JSON.stringify({
        expectedRevision: opened.revision,
        clientMutationId: crypto.randomUUID(),
        document: { ...opened.document, title: "Other writer" },
      }),
    });
    store.loadProject(
      JSON.stringify({ ...opened.document, title: "My conflicting draft" }),
      assets,
    );
    const save = await session.prepareToLeave("save");
    const status = session.getStatus();
    // Keep the stale draft locally without changing the winning server copy
    const recovery = await session.prepareToLeave("recovery");
    const current = await (
      await fetch("/api/projects/" + opened.document.projectId)
    ).json();
    return {
      winner: winner.status,
      save,
      status,
      recovery,
      title: current.document.title,
    };
  }, independentlyOpened.value);
  assert.equal(conflict.winner, 200);
  assert.equal(conflict.save.ok, false);
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(conflict.recovery, { ok: true, value: true });
  assert.equal(conflict.title, "Other writer");
  process.stdout.write("browser project list/open/session switch passed\n");
} finally {
  await browser.close();
}
