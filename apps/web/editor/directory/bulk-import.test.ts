import { afterEach, beforeEach, expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { createDirectoryClient, DirectoryWriteUnconfirmed } from "./directory-client";
import { ImportRequestError } from "./bulk-import";

const actor = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const other = "12e5c301-311c-40ff-b81a-2087c87420bb";
const learner = "bbf2b1d0-b388-4df8-a995-930148dcdd19";
const session = { userId: actor, role: "Administrator", mustChangePassword: false };
const values = [
  {
    displayName: "Existing",
    userName: "existing",
    role: "Educator" as const,
    initialPassword: "unused-initial-value",
  },
  {
    displayName: "Created",
    userName: "created",
    role: "Creator" as const,
    initialPassword: "returned-initial-value",
  },
];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function receipt(operationId: string) {
  return {
    operationId,
    orgId: org,
    acknowledged: false,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    created: [{ userId: learner, userName: "created", displayName: "Created", role: "Creator" }],
    credentials: [{ userId: learner, userName: "created", password: values[1]!.initialPassword }],
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

it("discovers only scoped operation summaries and recovers a selected receipt without consuming the local pending one", async () => {
  let localId = "";
  const serverId = other;
  const expiresAt = "2026-11-15T10:00:00Z";
  const createdAt = "2026-11-14T10:00:00Z";
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    const path = String(url);
    expect(incoming.headers.get("X-Spatia-Account")).toBe(actor);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/csrf")) return json({ requestToken: "csrf" });
    if (incoming.method === "PUT") {
      localId = path.split("/").at(-1)!;
      return Response.error();
    }
    if (path.endsWith("/acknowledge")) return new Response(null, { status: 204 });
    if (path.endsWith("/receipt")) return json(receipt(serverId));
    expect(incoming.method).toBe("GET");
    expect(path).toContain(`/organizations/${org}/bulk-imports?limit=20`);
    if (path.includes("cursor="))
      return json({
        items: [{ operationId: learner, createdAt, expiresAt, createdCount: 2 }],
        nextCursor: null,
      });
    return json({
      items: [{ operationId: serverId, createdAt, expiresAt, createdCount: 1 }],
      nextCursor: serverId,
    });
  });
  const owner = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(owner.start(values)).rejects.toThrow();
  const listed = await owner.discover();
  expect(listed).toEqual([
    { operationId: serverId, createdAt, expiresAt, createdCount: 1 },
    { operationId: learner, createdAt, expiresAt, createdCount: 2 },
  ]);
  expect((await owner.load(listed[0]!.operationId)).available).toBe(1);
  await owner.acknowledge(serverId);
  expect(owner.pending()).toBe(localId);
  expect(request.requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
});

it("discards a discovered list when the identity changes or a page cannot be verified", async () => {
  let malformed = false;
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    if (String(url).endsWith("/session")) return json({ ...session, userId: other });
    return json({
      items: [
        {
          operationId: other,
          createdAt: "2026-11-14T10:00:00Z",
          expiresAt: "2026-11-15T10:00:00Z",
          createdCount: malformed ? -1 : 0,
        },
      ],
      nextCursor: null,
    });
  });
  const owner = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(owner.discover()).rejects.toThrow("account changed");
  malformed = true;
  await expect(owner.discover()).rejects.toThrow("list");
  expect(owner.pending()).toBeNull();
});

it("keeps an import editable after a failed preflight or an authoritative first rejection", async () => {
  const request = await serveResponses(
    json({}, 503),
    json({ requestToken: "csrf" }),
    json({ code: "invalid_account_input" }, 400),
  );
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow("could not be sent");
  expect(client.pending()).toBeNull();
  await expect(client.start(values)).rejects.toThrow("account details");
  expect(client.pending()).toBeNull();
  expect(request.requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
});

it("does not confirm or release an uncertain handoff for an unexpected success payload", async () => {
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (String(url).endsWith("/acknowledge")) return json(null, 200);
    return json({}, 503);
  });
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow();
  const operation = client.pending()!;
  await expect(client.acknowledge(operation)).rejects.toThrow();
  expect(client.pending()).toBe(operation);
});

it("persists only one opaque scoped ID before dispatch and recovers only its created accounts after reload", async () => {
  let operationId = "";
  let acknowledgeLost = true;
  let acknowledged = false;
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    expect(incoming.headers.get("X-Spatia-Account")).toBe(actor);
    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (url === "/api/v1/auth/session") return json(session);
    expect(incoming.headers.get("X-CSRF-TOKEN")).toBe("csrf");
    const path = String(url);
    if (incoming.method === "PUT") {
      operationId = path.split("/").at(-1)!;
      expect(localStorage.length).toBe(1);
      expect(localStorage.getItem(`spatia.bulk-import:${actor}:${org}`)).toBe(operationId);
      return Response.error();
    }
    if (path.endsWith("/acknowledge")) {
      acknowledged = true;
      if (acknowledgeLost) {
        acknowledgeLost = false;
        return Response.error();
      }
      return new Response(null, { status: 204 });
    }
    return json({
      ...receipt(operationId),
      acknowledged,
      ...(acknowledged ? { credentials: [] } : {}),
    });
  });
  const first = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(first.start(values)).rejects.toBeInstanceOf(DirectoryWriteUnconfirmed);
  expect(request.requests[1]?.cache).toBe("no-store");
  const reopened = createDirectoryClient(request.fetch, actor).bulkImport(org);
  expect(reopened.pending()).toBe(operationId);
  expect(createDirectoryClient(request.fetch, other).bulkImport(org).pending()).toBeNull();
  expect(createDirectoryClient(request.fetch, actor).bulkImport(other).pending()).toBeNull();
  await expect(reopened.start(values)).rejects.toThrow("previous");
  const recovered = await reopened.load(operationId);
  expect(recovered.created.map((account) => account.userId)).toEqual([learner]);
  expect(recovered.credentials).toEqual([values[1]]);
  await expect(reopened.acknowledge(operationId)).rejects.toBeInstanceOf(DirectoryWriteUnconfirmed);
  expect(reopened.pending()).toBe(operationId);
  expect(await reopened.load(operationId)).toMatchObject({ acknowledged: true, available: 0 });
  await reopened.acknowledge(operationId);
  expect(reopened.pending()).toBeNull();
  expect(request.requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
});

it("retains a missing receipt until canceled and recognizes a commit that wins the cancel race", async () => {
  let committed = false;
  let operationId = "";
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (url === "/api/v1/auth/session") return json(session);
    const path = String(url);
    if (incoming.method === "PUT") {
      operationId = path.split("/").at(-1)!;
      return json({}, 503);
    }
    if (path.endsWith("/receipt"))
      return committed ? json(receipt(operationId)) : json({ code: "bulk_import_not_found" }, 404);
    return committed
      ? json({ code: "bulk_import_committed" }, 409)
      : new Response(null, { status: 204 });
  });
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow();
  await expect(client.load(operationId)).rejects.toBeInstanceOf(ImportRequestError);
  expect(client.pending()).toBe(operationId);
  committed = true;
  await expect(client.abandon(operationId)).rejects.toMatchObject({
    code: "bulk_import_committed",
  });
  expect((await client.load(operationId)).available).toBe(1);
  committed = false;
  await client.abandon(operationId);
  expect(client.pending()).toBeNull();
});

it("shows the created rows without credentials after server expiry", async () => {
  let operationId = "";
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    if (url === "/api/v1/auth/csrf") return json({ requestToken: "token" });
    if (url === "/api/v1/auth/session") return json(session);
    if (incoming.method === "PUT") {
      operationId = String(url).split("/").at(-1)!;
      return json({}, 503);
    }
    return json({ ...receipt(operationId), expiresAt: "2020-01-01T00:00:00Z", credentials: [] });
  });
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow();
  const result = await client.load(operationId);
  expect(result.created.map((account) => account.userName)).toEqual(["created"]);
  expect(result.credentials).toEqual([]);
  expect(result.acknowledged).toBe(false);
  expect(client.pending()).toBe(operationId);
});

it("refuses crossed receipts, uncreated credential rows and a changed post-response identity", async () => {
  let operationId = "";
  let changed = false;
  let response: Partial<ReturnType<typeof receipt>> = {};
  const request = await serveHttp((incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const url = pathname + search;

    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (url === "/api/v1/auth/session")
      return json({ ...session, userId: changed ? other : actor });
    if (incoming.method === "PUT") {
      operationId = String(url).split("/").at(-1)!;
      return Response.error();
    }
    return json({ ...receipt(operationId), ...response });
  });
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow();
  for (const invalid of [
    { operationId: other },
    { orgId: other },
    { credentials: [{ userId: other, userName: "existing", password: "unverified-value" }] },
    { acknowledged: true },
  ]) {
    response = invalid;
    await expect(client.load(operationId)).rejects.toThrow("receipt");
  }
  response = {};
  changed = true;
  await expect(client.load(operationId)).rejects.toThrow("account changed");
  expect(client.pending()).toBe(operationId);
});

it("retains the bulk operation when a dispatched write returns 401", async () => {
  const request = await serveResponses(json({ requestToken: "csrf" }), json({}, 401));
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow();
  expect(client.pending()).not.toBeNull();
});

it.each([401, 403])("releases the bulk marker for a %s preflight denial", async (status) => {
  const request = await serveResponses(json({}, status));
  const client = createDirectoryClient(request.fetch, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow("could not be sent");
  expect(client.pending()).toBeNull();
  expect(request.requests).toHaveLength(1);
});

it("does not dispatch a bulk import when the recovery marker cannot be stored", async () => {
  localStorage.setItem("q", "x".repeat(5 * 1024 * 1024 - 1));
  const request = await serveResponses();
  await expect(
    createDirectoryClient(request.fetch, actor).bulkImport(org).start(values),
  ).rejects.toThrow();
  expect(request.requests).toHaveLength(0);
});
