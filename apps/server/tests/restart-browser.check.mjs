import { launchBrowser } from "../../web/tests/browser-security.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const applicationCookie = "__Host-Spatia.Application";
const administratorTemporary = "Synthetic restart administrator password 1!";
const administratorPermanent = "Synthetic restart administrator password 2!";
const creatorTemporary = "Synthetic restart creator password 3!";
const creatorPermanent = "Synthetic restart creator password 4!";
const contexts = [];
let browser;
let stage = "configuration";

const parseOrigin = (value) => {
  const target = new URL(value);
  assert.equal(target.protocol, "https:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.username, "");
  assert.equal(target.password, "");
  assert.equal(target.pathname, "/");
  assert.equal(target.search, "");
  assert.equal(target.hash, "");
  return target.origin;
};

const waitForRestart = () => new Promise((resolve, reject) => {
  const input = createInterface({ input: process.stdin, terminal: false });
  const finish = (line) => {
    clearTimeout(timeout);
    input.removeAllListeners();
    input.close();
    process.stdin.pause();
    if (line === undefined) { reject(new Error("Restart handshake ended")); }
    else { resolve(line); }
  };
  const timeout = setTimeout(() => finish(undefined), 150_000);
  input.once("line", finish);
  input.once("close", () => finish(undefined));
});

const get = (page, path) => page.evaluate(async (path) => {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  return { status: response.status, body: await response.json(),
    noStore: response.headers.get("Cache-Control")?.includes("no-store") === true };
}, path);

const write = (page, path, body, method = "POST") => page.evaluate(async ({ path, body, method }) => {
  const bootstrap = await fetch("/api/auth/csrf", { cache: "no-store" });
  if (bootstrap.status !== 200) { throw new Error("CSRF bootstrap failed"); }
  const { requestToken } = await bootstrap.json();
  const response = await fetch(path, { method, credentials: "same-origin", headers: {
    "Content-Type": "application/json", "X-CSRF-TOKEN": requestToken,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json(),
    noStore: response.headers.get("Cache-Control")?.includes("no-store") === true };
}, { path, body, method });

const session = async (page, expected) => {
  const response = await get(page, "/api/auth/session");
  assert.equal(response.status, 200);
  assert.equal(response.noStore, true);
  assert.deepEqual(response.body, expected);
};

const storageIsEmpty = async (page) => {
  assert.equal(await page.evaluate(async () =>
    document.cookie === "" && localStorage.length === 0 && sessionStorage.length === 0
      && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0), true);
};

const checkCookies = async (context) => {
  const cookies = await context.cookies();
  for (const name of [applicationCookie, "__Host-Spatia.Antiforgery"]) {
    const cookie = cookies.find((candidate) => candidate.name === name);
    assert.ok(cookie);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.path, "/");
  }
  assert.equal(cookies.find((cookie) => cookie.name === applicationCookie).expires, -1);
};

try {
  let origin = parseOrigin(process.argv[2]);
  const administratorName = process.argv[3];
  assert.equal(typeof administratorName, "string");
  assert.ok(administratorName.length > 0 && administratorName.length <= 256);
  const playwrightUrl = new URL("../../web/node_modules/playwright/index.mjs", import.meta.url);
  const playwrightVersion = createRequire(playwrightUrl)("./package.json").version;
  browser = await launchBrowser({ target: origin });
  process.stdout.write(`node ${process.version}; playwright ${playwrightVersion}; chromium ${browser.version()}\n`);

  const freshPage = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    assert.equal((await context.cookies()).length, 0);
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) { await route.abort(); return; }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(origin + "/api/auth/csrf");
    return { context, page };
  };

  stage = "initial administrator login";
  const administrator = await freshPage();
  assert.equal((await get(administrator.page, "/api/auth/session")).status, 401);
  assert.equal((await write(administrator.page, "/api/auth/login",
    { userName: administratorName, password: administratorTemporary })).status, 204);
  const firstSession = await get(administrator.page, "/api/auth/session");
  assert.equal(firstSession.status, 200);
  const administratorSession = { userId: firstSession.body.userId, displayName: administratorName,
    role: "Administrator", orgId: null, mustChangePassword: true };
  await session(administrator.page, administratorSession);
  assert.equal((await write(administrator.page, "/api/auth/password",
    { currentPassword: administratorTemporary, newPassword: administratorPermanent })).status, 204);
  administratorSession.mustChangePassword = false;
  await session(administrator.page, administratorSession);

  stage = "persisted organization and creator provisioning";
  const organizationName = "Restart organization " + randomUUID();
  const organization = await write(administrator.page, "/api/admin/organizations", { name: organizationName });
  assert.equal(organization.status, 201);
  assert.equal(organization.noStore, true);
  assert.equal(typeof organization.body.id, "string");
  assert.equal(organization.body.name, organizationName);
  assert.equal(organization.body.isActive, true);
  const creatorName = "restart-creator-" + randomUUID();
  const created = await write(administrator.page, "/api/admin/users", {
    userName: creatorName, initialPassword: creatorTemporary, role: "Creator", orgId: organization.body.id,
  });
  assert.equal(created.status, 201);
  assert.equal(created.noStore, true);
  assert.equal(typeof created.body.userId, "string");
  assert.deepEqual(created.body, { userId: created.body.userId, userName: creatorName,
    role: "Creator", orgId: organization.body.id, isActive: true, mustChangePassword: true });
  const creatorSession = { userId: created.body.userId, displayName: creatorName,
    role: "Creator", orgId: organization.body.id, mustChangePassword: true };

  stage = "project creation assignment and committed saves";
  const project = await write(administrator.page, "/api/projects", {
    title: "Restart project", environmentAssetId: "test-room-v1", orgId: organization.body.id,
  });
  assert.equal(project.status, 201);
  assert.equal(project.noStore, true);
  assert.equal(project.body.revision, 0);
  const projectPath = "/api/projects/" + project.body.projectId;
  const assigned = await write(administrator.page, projectPath + "/assignments", {
    expectedRevision: 0, managedByUserIds: [], assignedCreatorIds: [created.body.userId], canPublishUserIds: [],
  }, "PATCH");
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.revision, 1);
  const document = JSON.parse(await readFile(new URL("../../web/shared/project/fixtures/m1-project.json", import.meta.url), "utf8"));
  document.projectId = project.body.projectId;
  document.title = "private-restart-project-body-not-for-logs";
  document.scenes[0].objects[0].transform.position = [5.125, 0, -3];
  const envelope = { expectedRevision: 1, clientMutationId: randomUUID(), document };
  const saved = await write(administrator.page, projectPath, envelope, "PUT");
  assert.equal(saved.status, 200);
  assert.equal(saved.noStore, true);
  assert.equal(saved.body.revision, 2);
  assert.equal(saved.body.projectId, project.body.projectId);
  assert.equal(saved.body.clientMutationId, envelope.clientMutationId);
  assert.deepEqual((await get(administrator.page, projectPath)).body.document, document);
  const newerDocument = structuredClone(document);
  newerDocument.title = "private-restart-project-body-not-for-logs-newer";
  newerDocument.scenes[0].objects[0].transform.position = [-2.5, 1, 4];
  const newerEnvelope = { expectedRevision: 2, clientMutationId: randomUUID(), document: newerDocument };
  const newerSave = await write(administrator.page, projectPath, newerEnvelope, "PUT");
  assert.equal(newerSave.status, 200);
  assert.equal(newerSave.noStore, true);
  assert.equal(newerSave.body.revision, 3);
  assert.equal(newerSave.body.projectId, project.body.projectId);
  assert.equal(newerSave.body.clientMutationId, newerEnvelope.clientMutationId);
  const beforeRestart = await get(administrator.page, projectPath);
  assert.equal(beforeRestart.status, 200);
  assert.equal(beforeRestart.noStore, true);
  assert.equal(beforeRestart.body.revision, 3);
  assert.equal(beforeRestart.body.updatedAt, newerSave.body.savedAt);
  assert.deepEqual(beforeRestart.body.document, newerDocument);
  await session(administrator.page, administratorSession);
  await checkCookies(administrator.context);
  await storageIsEmpty(administrator.page);
  const retainedCookie = (await administrator.context.cookies())
    .find((cookie) => cookie.name === applicationCookie).value;
  const capturedAt = Date.now();

  stage = "restart handshake";
  const replacement = waitForRestart();
  process.stdout.write("restart-ready\n");
  const next = JSON.parse(await replacement);
  assert.deepEqual(Object.keys(next), ["origin"]);
  origin = parseOrigin(next.origin);
  browser.allowLocalOrigin(origin);

  stage = "retained administrator session";
  assert.ok(Date.now() - capturedAt < 5 * 60_000);
  await administrator.page.goto(origin + "/api/auth/csrf");
  await session(administrator.page, administratorSession);
  assert.equal((await administrator.context.cookies())
    .find((cookie) => cookie.name === applicationCookie).value, retainedCookie);
  await checkCookies(administrator.context);
  await storageIsEmpty(administrator.page);
  process.stdout.write("restart retained session passed\n");

  stage = "historical save retry after restart";
  const replay = await write(administrator.page, projectPath, envelope, "PUT");
  assert.equal(replay.status, 200);
  assert.equal(replay.noStore, true);
  assert.deepEqual(replay.body, saved.body);
  const afterReplay = await get(administrator.page, projectPath);
  assert.equal(afterReplay.status, 200);
  assert.equal(afterReplay.noStore, true);
  assert.deepEqual(afterReplay.body, beforeRestart.body);
  const inconsistentReuse = await write(administrator.page, projectPath,
    { ...envelope, expectedRevision: 3, document: newerDocument }, "PUT");
  assert.equal(inconsistentReuse.status, 409);
  assert.equal(inconsistentReuse.noStore, true);
  assert.equal(inconsistentReuse.body.code, "revision_conflict");
  assert.equal(inconsistentReuse.body.currentRevision, 3);
  const afterConflict = await get(administrator.page, projectPath);
  assert.equal(afterConflict.status, 200);
  assert.equal(afterConflict.noStore, true);
  assert.deepEqual(afterConflict.body, beforeRestart.body);
  process.stdout.write("restart committed save retry passed\n");

  stage = "fresh creator password lifecycle";
  const creator = await freshPage();
  assert.equal((await get(creator.page, "/api/auth/session")).status, 401);
  assert.equal((await creator.context.cookies()).some((cookie) => cookie.name === applicationCookie), false);
  assert.equal((await write(creator.page, "/api/auth/login",
    { userName: creatorName, password: creatorTemporary })).status, 204);
  await session(creator.page, creatorSession);
  assert.equal((await get(creator.page, projectPath)).status, 403);
  assert.equal((await write(creator.page, "/api/auth/password",
    { currentPassword: creatorTemporary, newPassword: creatorPermanent })).status, 204);
  creatorSession.mustChangePassword = false;
  await session(creator.page, creatorSession);
  await checkCookies(creator.context);
  await storageIsEmpty(creator.page);
  stage = "fresh authorized browser reopens the durable project";
  const list = await get(creator.page, "/api/projects");
  assert.equal(list.status, 200);
  assert.equal(list.noStore, true);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].projectId, project.body.projectId);
  assert.equal(list.body.items[0].revision, 3);
  const opened = await get(creator.page, projectPath);
  assert.equal(opened.status, 200);
  assert.equal(opened.noStore, true);
  assert.deepEqual(opened.body, { projectId: project.body.projectId, revision: 3,
    updatedAt: newerSave.body.savedAt, document: newerDocument,
    permissions: { canEdit: true, canManage: false, canPublish: false } });
  await storageIsEmpty(creator.page);
  process.stdout.write("restart fresh browser project reopen passed\n");
  assert.equal((await write(creator.page, "/api/auth/logout")).status, 204);
  assert.equal((await get(creator.page, "/api/auth/session")).status, 401);
  assert.equal((await creator.context.cookies()).some((cookie) => cookie.name === applicationCookie), false);
  await storageIsEmpty(creator.page);
  await creator.context.close();
  contexts.splice(contexts.indexOf(creator.context), 1);
  process.stdout.write("restart fresh browser lifecycle passed\n");

  stage = "replacement password durability";
  const returning = await freshPage();
  assert.equal((await get(returning.page, "/api/auth/session")).status, 401);
  const previousPassword = await write(returning.page, "/api/auth/login",
    { userName: creatorName, password: creatorTemporary });
  assert.equal(previousPassword.status, 401);
  assert.equal(previousPassword.body.code, "login_failed");
  assert.equal((await write(returning.page, "/api/auth/login",
    { userName: creatorName, password: creatorPermanent })).status, 204);
  await session(returning.page, creatorSession);
  await storageIsEmpty(returning.page);
  assert.equal((await write(returning.page, "/api/auth/logout")).status, 204);
  assert.equal((await get(returning.page, "/api/auth/session")).status, 401);
  process.stdout.write("restart password durability passed\n");
} catch {
  process.stderr.write(`Restart browser acceptance failed at ${stage}.\n`);
  process.exitCode = 1;
} finally {
  for (const context of contexts.reverse()) {
    try { await context.close(); }
    catch { process.stderr.write("Restart browser context cleanup failed.\n"); process.exitCode = 1; }
  }
  if (browser) {
    try { await browser.close(); }
    catch { process.stderr.write("Restart browser cleanup failed.\n"); process.exitCode = 1; }
  }
  process.stdin.pause();
}
