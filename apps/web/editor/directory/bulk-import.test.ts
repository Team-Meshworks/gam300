import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const records = new Map<string, string>();
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
beforeEach(() => {
  records.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
    removeItem: (key: string) => records.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("discovers only scoped operation summaries and recovers a selected receipt without consuming the local pending one", async () => {
  let localId = "";
  const serverId = other;
  const expiresAt = "2026-11-15T10:00:00Z";
  const createdAt = "2026-11-14T10:00:00Z";
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    expect(new Headers(init?.headers).get("X-Spatia-Account")).toBe(actor);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/csrf")) return json({ requestToken: "csrf" });
    if (init?.method === "PUT") {
      localId = path.split("/").at(-1)!;
      throw new TypeError("Request outcome unknown");
    }
    if (path.endsWith("/acknowledge")) return new Response(null, { status: 204 });
    if (path.endsWith("/receipt")) return json(receipt(serverId));
    expect(init?.method).toBeUndefined();
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
  const owner = createDirectoryClient(request, actor).bulkImport(org);
  await expect(owner.start(values)).rejects.toThrow();
  const listed = await owner.discover();
  expect(listed).toEqual([
    { operationId: serverId, createdAt, expiresAt, createdCount: 1 },
    { operationId: learner, createdAt, expiresAt, createdCount: 2 },
  ]);
  expect((await owner.load(listed[0]!.operationId)).available).toBe(1);
  await owner.acknowledge(serverId);
  expect(owner.pending()).toBe(localId);
  expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
});

it("discards a discovered list when the identity changes or a page cannot be verified", async () => {
  let malformed = false;
  const request = vi.fn<typeof fetch>(async (url) => {
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
  const owner = createDirectoryClient(request, actor).bulkImport(org);
  await expect(owner.discover()).rejects.toThrow("account changed");
  malformed = true;
  await expect(owner.discover()).rejects.toThrow("list");
  expect(owner.pending()).toBeNull();
});

it("keeps an import editable after a failed preflight or an authoritative first rejection", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({}, 503))
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(json({ code: "invalid_account_input" }, 400));
  const client = createDirectoryClient(request, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow("could not be sent");
  expect(client.pending()).toBeNull();
  await expect(client.start(values)).rejects.toThrow("account details");
  expect(client.pending()).toBeNull();
  expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
});

it("does not confirm or release an uncertain handoff for an unexpected success payload", async () => {
  const request = vi.fn<typeof fetch>(async (url) => {
    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (String(url).endsWith("/acknowledge")) return json(null, 200);
    return json({}, 503);
  });
  const client = createDirectoryClient(request, actor).bulkImport(org);
  await expect(client.start(values)).rejects.toThrow();
  const operation = client.pending()!;
  await expect(client.acknowledge(operation)).rejects.toThrow();
  expect(client.pending()).toBe(operation);
});

it("persists only one opaque scoped ID before dispatch and recovers only its created accounts after reload", async () => {
  let operationId = "";
  let acknowledgeLost = true;
  let acknowledged = false;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("X-Spatia-Account")).toBe(actor);
    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (url === "/api/v1/auth/session") return json(session);
    expect(new Headers(init?.headers).get("X-CSRF-TOKEN")).toBe("csrf");
    expect(init?.cache).toBe("no-store");
    const path = String(url);
    if (init?.method === "PUT") {
      operationId = path.split("/").at(-1)!;
      expect([...records.values()]).toEqual([operationId]);
      throw new TypeError("Connection closed after commit");
    }
    if (path.endsWith("/acknowledge")) {
      acknowledged = true;
      if (acknowledgeLost) {
        acknowledgeLost = false;
        throw new TypeError("Lost acknowledgement");
      }
      return new Response(null, { status: 204 });
    }
    return json({
      ...receipt(operationId),
      acknowledged,
      ...(acknowledged ? { credentials: [] } : {}),
    });
  });
  const first = createDirectoryClient(request, actor).bulkImport(org);
  await expect(first.start(values)).rejects.toBeInstanceOf(DirectoryWriteUnconfirmed);
  const reopened = createDirectoryClient(request, actor).bulkImport(org);
  expect(reopened.pending()).toBe(operationId);
  expect(createDirectoryClient(request, other).bulkImport(org).pending()).toBeNull();
  expect(createDirectoryClient(request, actor).bulkImport(other).pending()).toBeNull();
  await expect(reopened.start(values)).rejects.toThrow("previous");
  const recovered = await reopened.load(operationId);
  expect(recovered.created.map((account) => account.userId)).toEqual([learner]);
  expect(recovered.credentials).toEqual([values[1]]);
  await expect(reopened.acknowledge(operationId)).rejects.toBeInstanceOf(DirectoryWriteUnconfirmed);
  expect(reopened.pending()).toBe(operationId);
  expect(await reopened.load(operationId)).toMatchObject({ acknowledged: true, available: 0 });
  await reopened.acknowledge(operationId);
  expect(reopened.pending()).toBeNull();
  expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
});

it("retains a missing receipt until canceled and recognizes a commit that wins the cancel race", async () => {
  let committed = false;
  let operationId = "";
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (url === "/api/v1/auth/session") return json(session);
    const path = String(url);
    if (init?.method === "PUT") {
      operationId = path.split("/").at(-1)!;
      return json({}, 503);
    }
    if (path.endsWith("/receipt"))
      return committed ? json(receipt(operationId)) : json({ code: "bulk_import_not_found" }, 404);
    return committed
      ? json({ code: "bulk_import_committed" }, 409)
      : new Response(null, { status: 204 });
  });
  const client = createDirectoryClient(request, actor).bulkImport(org);
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
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (url === "/api/v1/auth/csrf") return json({ requestToken: "token" });
    if (url === "/api/v1/auth/session") return json(session);
    if (init?.method === "PUT") {
      operationId = String(url).split("/").at(-1)!;
      return json({}, 503);
    }
    return json({ ...receipt(operationId), expiresAt: "2020-01-01T00:00:00Z", credentials: [] });
  });
  const client = createDirectoryClient(request, actor).bulkImport(org);
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
  let response: Record<string, unknown> = {};
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (url === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (url === "/api/v1/auth/session")
      return json({ ...session, userId: changed ? other : actor });
    if (init?.method === "PUT") {
      operationId = String(url).split("/").at(-1)!;
      throw new TypeError("Receipt unavailable");
    }
    return json({ ...receipt(operationId), ...response });
  });
  const client = createDirectoryClient(request, actor).bulkImport(org);
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
