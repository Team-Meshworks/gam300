import { launchBrowser } from "../../web/tests/browser-security.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const accounts = JSON.parse(process.argv[3]);
const manager = JSON.parse(process.argv[4]);
const editorDirectory = process.argv[5];
assert.ok(editorDirectory, "The HTTPS fixture must supply its private editor build directory");
const origin = target.origin;
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
      export { writeServerDraft } from "${webRoot}editor/persistence/server-draft-write.ts";
      export { loadRecoverySession } from "${webRoot}editor/persistence/local-drafts.ts";
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
const browser = await launchBrowser({ target: origin, args: ["--enable-unsafe-swiftshader"], verificationOutput: "stdout" });
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
  const flow = await page.evaluate(async ({ accounts, manager }) => {
    const get = async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
    };
    const post = async (path, body) => {
      const csrf = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
      return (await fetch(path, { method: "POST", headers: {
        "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
      }, ...(body ? { body: JSON.stringify(body) } : {}) })).status;
    };
    const anonymous = await get("/api/v1/projects");
    const sessions = [];
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      const login = await post("/api/v1/auth/login", { userName: account.userName, password: "Synthetic-long-password1!" });
      sessions.push({ login, list: await get("/api/v1/projects"), open: await get("/api/v1/projects/" + account.projectId),
        denied: await get("/api/v1/projects/" + accounts[1 - index].projectId),
        grants: await get("/api/v1/projects/" + account.projectId + "/assignments") });
    }
    const managerLogin = await post("/api/v1/auth/login", { userName: manager.userName, password: "Synthetic-long-password1!" });
    const grants = await get("/api/v1/projects/" + accounts[0].projectId + "/assignments");
    const logout = await post("/api/v1/auth/logout");
    return { anonymous, sessions, managerLogin, grants, logout,
      afterLogout: await get("/api/v1/projects/" + accounts[1].projectId),
      grantsAfterLogout: await get("/api/v1/projects/" + accounts[0].projectId + "/assignments") };
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
    const absent = await fetch("/api/v1/projects/" + account.projectId);
    const csrf = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
    const login = await fetch("/api/v1/auth/login", { method: "POST", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": csrf,
    }, body: JSON.stringify({ userName: account.userName, password: "Synthetic-long-password1!" }) });
    const open = await fetch("/api/v1/projects/" + account.projectId);
    return { absent: absent.status, login: login.status, open: open.status, body: await open.json() };
  }, accounts[0]);
  assert.equal(reopened.absent, 401);
  assert.equal(reopened.login, 204);
  assert.equal(reopened.open, 200);
  assert.deepEqual(reopened.body, flow.sessions[0].open.body);
  // Save through the real coordinator, then reopen from a separate authenticated browser
  const saved = await fresh.evaluate(async (projectId) => {
    const account = await (await fetch("/api/v1/auth/session")).json();
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
    const token = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
    await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
      body: JSON.stringify({
        userName: account.userName,
        password: "Synthetic-long-password1!",
      }),
    });
    const identity = await (await fetch("/api/v1/auth/session")).json();
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
    const token = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
    // A second writer advances the server before this stale editor saves
    const winner = await fetch("/api/v1/projects/" + opened.document.projectId, {
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
      await fetch("/api/v1/projects/" + opened.document.projectId)
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
  // Exercise offline backup and a lost acknowledgement against durable server receipts
  // Keep this fixture on the shared coordinator rather than adding recovery state to a teammate's screen
  const retryPage = await openPage();
  await retryPage.evaluate(async (account) => {
    const token = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
    await fetch("/api/v1/auth/login", { method: "POST", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": token,
    }, body: JSON.stringify({ userName: account.userName, password: "Synthetic-long-password1!" }) });
    const identity = await (await fetch("/api/v1/auth/session")).json();
    const assets = new Map([["test-room-v1", "environment"], ["test-crate-v1", "model"]]);
    const controller = new AbortController();
    const opened = await serverRecoveryTest.readServerProject(account.projectId, identity.userId, assets, controller.signal);
    if (!opened.ok) throw new Error("Retry fixture could not open its project");
    const store = serverRecoveryTest.createDocumentStore([]);
    store.loadProject(JSON.stringify(opened.value.document), assets);
    const requests = [];
    let loseReceipt = true;
    const session = serverRecoveryTest.connectServerProjectSession({
      accountId: identity.userId, store, revision: opened.value.revision,
      storageRevision: 0, assetKinds: assets, signal: controller.signal, onStatus() {},
      // Drive reconnect explicitly so browser network events cannot race the lost-receipt step
      events: new EventTarget(),
      write: async (request, signal) => {
        requests.push(request.body);
        const result = await serverRecoveryTest.writeServerDraft(request, signal);
        // Hide one real committed receipt from the coordinator to reproduce an uncertain network outcome
        if (loseReceipt && result.kind === "saved") {
          loseReceipt = false;
          return { kind: "failed" };
        }
        return result;
      },
    });
    store.loadProject(JSON.stringify({ ...opened.value.document, title: "Offline pending draft" }), assets);
    globalThis.retryScenario = { session, assets, requests, opened: opened.value };
  }, accounts[1]);
  await retryPage.context().setOffline(true);
  const offline = await retryPage.evaluate(async () => {
    const { session, assets, opened } = retryScenario;
    await session.flush();
    const recovery = await serverRecoveryTest.loadRecoverySession(assets, {
      accountId: opened.accountId, projectId: opened.document.projectId,
    });
    return { status: session.getStatus(), recovery };
  });
  assert.equal(offline.status, "failed");
  assert.equal(offline.recovery.ok, true);
  assert.equal(offline.recovery.value.document.title, "Offline pending draft");
  assert.ok(offline.recovery.value.serverSave.pending);
  await retryPage.context().setOffline(false);
  const reconciled = await retryPage.evaluate(async () => {
    const { session, requests, opened } = retryScenario;
    // Reconnect commits the pending request, then loses only its acknowledgement
    await session.flush();
    const uncertain = session.getStatus();
    const path = "/api/v1/projects/" + opened.document.projectId;
    const committed = await (await fetch(path)).json();
    const token = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
    const newer = await fetch(path, { method: "PUT", headers: {
      "Content-Type": "application/json", "X-CSRF-TOKEN": token,
    }, body: JSON.stringify({ expectedRevision: committed.revision, clientMutationId: crypto.randomUUID(),
      document: { ...committed.document, title: "Newer independently saved draft" } }) });
    // Retry identical bytes after another revision exists; acknowledgement must never overwrite that newer draft
    await session.flush();
    const status = session.getStatus();
    const current = await (await fetch(path)).json();
    await session.dispose();
    return { uncertain, newer: newer.status, status, current, requests, initialRevision: opened.revision };
  });
  assert.equal(reconciled.uncertain, "failed");
  assert.equal(reconciled.newer, 200);
  assert.equal(reconciled.status, "saved");
  assert.equal(reconciled.current.revision, reconciled.initialRevision + 2);
  assert.equal(reconciled.current.document.title, "Newer independently saved draft");
  assert.equal(reconciled.requests.length, 3);
  assert.ok(reconciled.requests.every((body) => body === reconciled.requests[0]));
  process.stdout.write("browser offline backup and durable historical retry passed\n");
  process.stdout.write("browser project list/open/session switch passed\n");
  const { checkServerEditor } = await import("./server-editor-browser.check.mjs");
  await checkServerEditor(browser, origin, accounts, build, webRoot, editorDirectory);
} finally {
  await browser.close();
}
