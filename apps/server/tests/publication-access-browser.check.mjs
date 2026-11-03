import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const data = JSON.parse(process.argv[3]);
const origin = target.origin;
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "../../web/node_modules/playwright/index.mjs"
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
console.log(`Node ${process.version}; Chromium ${browser.version()}`);
const pages = {};
let protectedReads = 0;
try {
  // Each actor has independent real cookies; no HTTP route or access response is mocked
  for (const name of ["anonymous", ...Object.keys(data.actors)]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    pages[name] = await context.newPage();
    await pages[name].goto(origin + "/_test/browser");
    if (name !== "anonymous") await login(name);
  }
  async function get(name, path, headers = {}) {
    return pages[name].evaluate(
      async ({ path, headers }) => {
        const response = await fetch(path, { headers, redirect: "error" });
        const bytes = await response.arrayBuffer();
        const text = new TextDecoder().decode(bytes);
        return {
          status: response.status,
          cache: response.headers.get("cache-control"),
          body: response.headers.get("content-type")?.includes("json")
            ? JSON.parse(text)
            : text,
          length: bytes.byteLength,
        };
      },
      { path, headers },
    );
  }
  async function write(name, path, body, method = "POST") {
    return pages[name].evaluate(
      async ({ path, body, method }) => {
        const token = (await (await fetch("/api/auth/csrf")).json())
          .requestToken;
        const response = await fetch(path, {
          method,
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": token,
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
      },
      { path, body, method },
    );
  }
  async function login(name) {
    const result = await write(name, "/api/auth/login", {
      userName: data.actors[name].userName,
      password: "Synthetic-long-password1!",
    });
    assert.equal(result.status, 204, name + " login");
  }
  const path = (id) => `/api/publications/${id ?? data.publicationId}`;
  const asset = (id) => `${path(id)}/assets/${data.assetId}/bytes`;
  const viewers = [data.actors.viewer.userId];
  async function policy(
    name,
    audience,
    action = "audience",
    ids = viewers,
    id = data.publicationId,
  ) {
    return write(name, path(id) + "/access", {
      audience,
      action,
      viewerIds: ids,
    });
  }
  async function change(
    name,
    audience,
    action = "audience",
    ids = viewers,
    id = data.publicationId,
  ) {
    const result = await policy(name, audience, action, ids, id);
    assert.equal(result.status, 204, `${name} ${action}: ${result.text}`);
  }
  async function pair(name, status, id = data.publicationId) {
    for (const resource of [path(id), asset(id)]) {
      const response = await get(name, resource);
      protectedReads++;
      assert.equal(response.status, status, `${name} ${resource}`);
      assert.match(response.cache ?? "", /no-store/);
      if (status === 404) {
        assert.match(response.body.title ?? "", /unavailable|access/i);
        assert.ok(
          !JSON.stringify(response.body).includes(
            "Protected publication snapshot",
          ),
        );
      }
    }
  }

  // Public and unlisted share anonymous access; management metadata spells out link possession
  for (const mode of ["Public", "Unlisted"]) {
    await change("publisher", mode);
    for (const name of ["anonymous", "unrelated", "foreign"])
      await pair(name, 200);
    const metadata = await get("publisher", path() + "/access");
    assert.equal(metadata.status, 200);
    assert.match(
      metadata.body.explanation,
      mode === "Unlisted" ? /anyone with the link/i : /without signing in/i,
    );
  }
  await pair("anonymous", 404, "invalid-publication");
  await pair("anonymous", 404, crypto.randomUUID());
  await change("publisher", "Authenticated");
  for (const [name, status] of Object.entries({
    anonymous: 404,
    viewer: 200,
    unrelated: 404,
    foreign: 404,
    publisher: 200,
    manager: 200,
    admin: 200,
  }))
    await pair(name, status);
  const original = (await get("viewer", path())).body;

  // Named visitor access cannot change policy, mutate a snapshot or obtain a private draft
  assert.equal((await get("anonymous", path() + "/access")).status, 401);
  assert.equal((await get("viewer", path() + "/access")).status, 404);
  assert.equal((await policy("viewer", "Public")).status, 404);
  assert.equal((await policy("publisher", "Public", "hide")).status, 404);
  assert.equal(
    (await get("viewer", `/api/projects/${data.projectId}`)).status,
    404,
  );
  assert.equal(
    (
      await write(
        "viewer",
        `/api/projects/${data.projectId}`,
        {
          expectedRevision: 0,
          clientMutationId: crypto.randomUUID(),
          document: original,
        },
        "PUT",
      )
    ).status,
    404,
  );
  assert.equal((await write("viewer", path(), original, "PUT")).status, 405);
  assert.equal(
    (await get("viewer", `/api/assets/${data.assetId}/bytes`)).status,
    404,
  );
  assert.equal(
    (await get("anonymous", `/api/assets/${data.assetId}/bytes`)).status,
    401,
  );
  assert.equal(
    (
      await policy("manager", "Authenticated", "audience", [
        data.actors.foreign.userId,
      ])
    ).status,
    400,
  );

  // Disabled viewers lose cookie-backed access and cannot be newly selected for an audience
  assert.equal(
    (
      await write(
        "admin",
        `/api/admin/users/${data.actors.viewer.userId}/active`,
        { isActive: false },
        "PATCH",
      )
    ).status,
    204,
  );
  await pair("viewer", 404);
  assert.equal((await policy("manager", "Authenticated")).status, 400);
  await change("manager", "Authenticated", "hide");
  await pair("admin", 404);
  await change("manager", "Authenticated", "show");
  assert.equal(
    (
      await write(
        "admin",
        `/api/admin/users/${data.actors.viewer.userId}/active`,
        { isActive: true },
        "PATCH",
      )
    ).status,
    204,
  );
  await login("viewer");
  await pair("viewer", 200);
  await change("publisher", "Authenticated", "audience", []);
  await pair("viewer", 404);
  await change("publisher", "Authenticated");
  await pair("viewer", 200);

  async function archive(archived) {
    const project = await get("admin", `/api/projects/${data.projectId}`);
    const result = await write(
      "admin",
      `/api/projects/${data.projectId}/archive`,
      { expectedRevision: project.body.revision, archived },
      "PATCH",
    );
    assert.equal(result.status, 200, result.text);
  }
  await archive(true);
  for (const name of ["viewer", "publisher", "manager", "admin"])
    await pair(name, 404);
  await archive(false);
  await pair("viewer", 200);

  // Reassignment removes permission-derived publisher access without transferring publisher identity
  let draft = (await get("admin", `/api/projects/${data.projectId}`)).body;
  assert.equal(
    (
      await write(
        "admin",
        `/api/projects/${data.projectId}/assignments`,
        {
          expectedRevision: draft.revision,
          managedByUserIds: [data.actors.manager.userId],
          assignedCreatorIds: [data.actors.unrelated.userId],
          canPublishUserIds: [data.actors.unrelated.userId],
        },
        "PATCH",
      )
    ).status,
    200,
  );
  await pair("publisher", 404);
  await pair("unrelated", 404);
  await change("manager", "Authenticated", "audience", [
    data.actors.publisher.userId,
    ...viewers,
  ]);
  await pair("publisher", 200);
  assert.equal((await policy("publisher", "Public")).status, 404);
  await change("manager", "Public");
  assert.equal(
    (
      await write(
        "admin",
        `/api/admin/users/${data.actors.publisher.userId}/active`,
        { isActive: false },
        "PATCH",
      )
    ).status,
    204,
  );
  await pair("anonymous", 200);
  await change("manager", "Authenticated");

  // Later draft edits do not alter the captured edition or its protected asset identity
  draft = (await get("admin", `/api/projects/${data.projectId}`)).body;
  draft.document.title = "Changed draft after publication";
  assert.equal(
    (
      await write(
        "admin",
        `/api/projects/${data.projectId}`,
        {
          expectedRevision: draft.revision,
          clientMutationId: crypto.randomUUID(),
          document: draft.document,
        },
        "PUT",
      )
    ).status,
    200,
  );
  assert.deepEqual((await get("viewer", path())).body, original);

  // Every new request must recheck revocation; conditional and range headers cannot revive cached content
  await change("manager", "Authenticated", "revoke");
  for (const name of ["anonymous", "viewer", "unrelated", "admin"])
    await pair(name, 404);
  assert.equal(
    (await get("viewer", asset(), { "If-None-Match": "*", Range: "bytes=0-9" }))
      .status,
    404,
  );
  await change("manager", "Public", "show");
  await change("manager", "Public");
  await pair("anonymous", 404);
  await archive(true);
  await archive(false);
  await pair("admin", 404);
  await change("admin", "Authenticated", "delete", [], data.deletedId);
  await pair("admin", 404, data.deletedId);
  assert.equal(
    (await policy("admin", "Public", "show", [], data.deletedId)).status,
    404,
  );
  console.log(
    `publication access matrix passed: ${protectedReads} protected reads with real PostgreSQL/API/browser sessions`,
  );
} finally {
  await browser.close();
}
