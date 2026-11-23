import { expect, it } from "vitest";
import { deferred } from "../../tests/deferred";
import {
  createOperationKey,
  readCreateOperation,
  sendCreateOperation as sendGuardedCreateOperation,
  creationHead,
  acknowledgeCreation,
  type CreationPurpose,
  releaseCreateOperation,
  duplicateCreateReceipt,
  creationReceipt,
} from "./create-operation";
import { isId, projectReceipt, type WriteResult } from "./workspace-api";
import { isRecord, readField } from "../../shared/project/validation-helpers";
import {
  creatorId as actor,
  organizationId as other,
  fillStorage,
  profileStorage as storage,
  serveCreation,
} from "../../tests/creation-fixture";

function sendCreateOperation(
  store: ReturnType<typeof storage>,
  key: string,
  actorId: string,
  server: Awaited<ReturnType<typeof serveCreation>>,
  verify: Parameters<typeof sendGuardedCreateOperation>[4],
  input?: Parameters<typeof sendGuardedCreateOperation>[5],
) {
  return sendGuardedCreateOperation(store, key, actorId, server.write, verify, input, server.read);
}

const value = { projectId: other, revision: 0, updatedAt: "2026-11-14T00:00:00Z", archived: false };
const input = { path: "/api/v1/projects", body: { title: "Museum" } };
it("persists before dispatch and replays the original body after a lost reply and reload", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  let writes = 0;
  const server = await serveCreation({
    write: (_path, body) => {
      expect(readCreateOperation(store, key, actor)?.body).toEqual(body);
      return ++writes === 1 ? Response.error() : Response.json(value);
    },
  });
  expect(await sendCreateOperation(store, key, actor, server, projectReceipt, input)).toEqual({
    kind: "unknown",
  });
  const pending = readCreateOperation(store, key, actor);
  expect(pending?.body.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await sendCreateOperation(store, key, actor, server, projectReceipt)).toEqual({
    kind: "confirmed",
    value,
  });
  expect(server.writes[1]).toEqual(server.writes[0]);
  expect(readCreateOperation(store, key, actor)).toEqual({ ...pending, receipt: value });
  expect(await sendCreateOperation(store, key, actor, server, projectReceipt)).toEqual({
    kind: "confirmed",
    value,
  });
  expect(server.writes).toHaveLength(2);
});

it("keeps a delayed request's identity when an early retry also loses its reply", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const gate = deferred<void>();
  const started = deferred<void>();
  let writes = 0;
  const server = await serveCreation({
    write: async () => {
      if (++writes !== 1) return Response.json(value);
      started.resolve();
      await gate.promise;
      return Response.error();
    },
  });
  const first = sendCreateOperation(store, key, actor, server, projectReceipt, input);
  await started.promise;
  const pending = readCreateOperation(store, key, actor);
  const retry = sendCreateOperation(store, key, actor, server, projectReceipt);
  gate.resolve();
  await first;
  await retry;
  expect(server.writes[1]?.body).toEqual(pending?.body);
});

it("allows deliberate identical new creates after explicit release, and isolates accounts", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const server = await serveCreation({ write: () => Response.json(value) });
  await sendCreateOperation(store, key, actor, server, projectReceipt, input);
  expect(await sendCreateOperation(store, key, actor, server, projectReceipt, input)).toMatchObject(
    {
      kind: "rejected",
      message:
        "An earlier creation succeeded. Review and accept its result before starting another.",
    },
  );
  expect(await releaseCreateOperation(store, actor, "project", store.getItem(key)!)).toBe(true);
  await sendCreateOperation(store, key, actor, server, projectReceipt, input);
  expect(server.writes[0]?.body).not.toEqual(server.writes[1]?.body);
  const lost = await serveCreation({ write: () => Response.error() });
  await sendCreateOperation(store, key, actor, lost, projectReceipt, input);
  expect(readCreateOperation(store, createOperationKey(other, "project"), other)).toBeNull();
  expect(() => readCreateOperation(store, key, other)).toThrow("verified");
  expect((await sendCreateOperation(store, key, other, server, projectReceipt)).kind).toBe(
    "rejected",
  );
  expect(server.writes).toHaveLength(2);
});

it("requires the original input for an unresolved operation and retains conflicting or invalid acknowledgements", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  let response = Response.error();
  const server = await serveCreation({ write: () => response });
  await sendCreateOperation(store, key, actor, server, projectReceipt, input);
  expect(
    (
      await sendCreateOperation(store, key, actor, server, projectReceipt, {
        ...input,
        body: { title: "Changed" },
      })
    ).kind,
  ).toBe("rejected");
  expect(server.writes).toHaveLength(1);
  response = Response.json(null);
  expect((await sendCreateOperation(store, key, actor, server, projectReceipt)).kind).toBe(
    "unknown",
  );
  response = Response.json({ code: "operation_conflict" }, { status: 409 });
  await sendCreateOperation(store, key, actor, server, projectReceipt);
  expect(readCreateOperation(store, key, actor)).not.toBeNull();
  response = Response.json({}, { status: 422 });
  await sendCreateOperation(store, key, actor, server, projectReceipt);
  expect(readCreateOperation(store, key, actor)).not.toBeNull();
});

it("stores only a digest for large imports and reconstructs the exact body from the reselected input", async () => {
  const store = storage();
  const key = createOperationKey(actor, "import");
  const imported = {
    ...input,
    retainBody: false as const,
    retry: true as const,
    body: { title: "Museum", document: "a".repeat(6_000_000) },
  };
  const server = await serveCreation({ write: () => Response.error() });
  await sendCreateOperation(store, key, actor, server, projectReceipt, imported);
  expect(store.getItem(key)!.length).toBeLessThan(400);
  await sendCreateOperation(store, key, actor, server, projectReceipt);
  expect(server.writes).toHaveLength(1);
  await sendCreateOperation(store, key, actor, server, projectReceipt, {
    ...imported,
    body: { ...imported.body, document: "changed" },
  });
  expect(server.writes).toHaveLength(1);
  await sendCreateOperation(store, key, actor, server, projectReceipt, imported);
  expect(server.writes[1]).toEqual(server.writes[0]);
});

it("does not dispatch without verified durable storage or create a new ID when retry data is missing", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const server = await serveCreation();
  await sendCreateOperation(store, key, actor, server, projectReceipt);
  const storageLosesWrite = {
    ...store,
    setItem(key: string, value: string) {
      store.setItem(key, value);
      store.removeItem(key);
    },
  };
  const uncertain = await sendCreateOperation(
    storageLosesWrite,
    key,
    actor,
    server,
    projectReceipt,
    input,
  );
  expect(uncertain).toEqual({
    kind: "rejected",
    message: "The browser could not save recovery information.",
  });
  expect(store.getItem(key)).toBeNull();
  store.setItem(key, "1");
  await sendCreateOperation(store, key, actor, server, projectReceipt, input);
  expect(server.writes).toHaveLength(0);
  expect(store.getItem(key)).toBe("1");
});

it("releases only the observed actor's attempt and never a newer tab's replacement", async () => {
  const store = storage();
  const key = createOperationKey(actor, "duplicate");
  const otherKey = createOperationKey(other, "duplicate");
  store.setItem(key, "unreadable marker");
  store.setItem(otherKey, "another actor's marker");
  const observed = store.getItem(key)!;
  let acquired!: () => void;
  let unlock!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const held = navigator.locks.request(key, async () => {
    acquired();
    await gate;
  });
  await ready;
  const releasing = releaseCreateOperation(store, actor, "duplicate", observed);
  store.setItem(key, "newer attempt");
  unlock();
  expect(await releasing).toBe(false);
  await held;
  expect(store.getItem(key)).toBe("newer attempt");
  expect(await releaseCreateOperation(store, actor, "duplicate", "newer attempt")).toBe(true);
  expect(store.getItem(key)).toBeNull();
  expect(store.getItem(otherKey)).toBe("another actor's marker");
});

it("allows an explicitly separate create after releasing a rejected pending retry without another write", async () => {
  const store = storage();
  const key = createOperationKey(actor, "duplicate");
  const copy = {
    path: "/api/v1/projects/" + other + "/duplicate",
    body: { expectedRevision: 0, title: "Copy" },
  };
  let response = Response.error();
  const server = await serveCreation({ write: () => response });
  await sendCreateOperation(store, key, actor, server, projectReceipt, copy);
  const observed = store.getItem(key)!;
  const firstId = readCreateOperation(store, key, actor)!.body.operationId;
  response = Response.json({ code: "revision_conflict" }, { status: 409 });
  await sendCreateOperation(store, key, actor, server, projectReceipt);
  expect(store.getItem(key)).toBe(observed);
  expect(await releaseCreateOperation(store, actor, "duplicate", observed)).toBe(true);
  expect(server.writes).toHaveLength(2);
  response = Response.error();
  await sendCreateOperation(store, key, actor, server, projectReceipt, {
    ...copy,
    body: { ...copy.body, expectedRevision: 1 },
  });
  expect(server.writes).toHaveLength(3);
  expect(readCreateOperation(store, key, actor)!.body.operationId).not.toBe(firstId);
});

it("rejects copy replay receipts that acknowledge the exact saved source project", async () => {
  const store = storage();
  const key = createOperationKey(actor, "duplicate");
  const copy = {
    path: "/api/v1/projects/" + other + "/duplicate",
    body: { expectedRevision: 0, title: "Copy" },
  };
  let response = Response.error();
  const server = await serveCreation({ write: () => response });
  await sendCreateOperation(store, key, actor, server, projectReceipt, copy);
  response = Response.json(value);
  const outcome = await sendCreateOperation(store, key, actor, server, (receipt) =>
    duplicateCreateReceipt(receipt, readCreateOperation(store, key, actor)),
  );
  expect(outcome.kind).toBe("unknown");
  expect(readCreateOperation(store, key, actor)).not.toBeNull();
  expect(
    duplicateCreateReceipt({ ...value, projectId: actor }, readCreateOperation(store, key, actor)),
  ).toBe(true);
});

async function generations(
  purpose: CreationPurpose = "project",
  beforeWrite?: (body: object) => void | Promise<void>,
) {
  let predecessor: string | null = null;
  const pending = new Map<string, unknown>();
  const committed = new Map<string, { body: object; receipt: unknown }>();
  let loseCreate = false;
  let loseAck = false;
  let rejectAck = false;
  const server = await serveCreation({
    head: () => {
      const entry = [...pending.entries()].at(-1);
      return Response.json(
        entry
          ? { state: "unacknowledged", operationId: entry[0], receipt: entry[1] }
          : { state: "ready", operationId: predecessor, receipt: null },
      );
    },
    write: async (path, body) => {
      if (path.endsWith("/acknowledge")) {
        if (rejectAck) return Response.error();
        pending.delete(path.split("/").at(-2)!);
        return loseAck ? Response.error() : new Response(null, { status: 204 });
      }
      await beforeWrite?.(body);
      const guard = readField(body, "creationGuard");
      const operationId = readField(body, "operationId");
      if (!isId(operationId) || !isRecord(guard))
        throw new Error("Expected an operation ID and creation guard");
      const prior = committed.get(operationId);
      if (prior)
        return JSON.stringify(prior.body) === JSON.stringify(body)
          ? Response.json(prior.receipt)
          : Response.json({ code: "operation_conflict" }, { status: 409 });
      if (pending.size || readField(guard, "previousOperationId") !== predecessor)
        return Response.json({ code: "creation_state_changed" }, { status: 409 });
      const receipt =
        path === "/api/v1/classes"
          ? { id: crypto.randomUUID(), organizationId: other, name: readField(body, "name") }
          : { ...value, projectId: crypto.randomUUID() };
      predecessor = operationId;
      pending.set(operationId, receipt);
      committed.set(operationId, { body, receipt });
      return loseCreate ? Response.error() : Response.json(receipt);
    },
  });
  return {
    ...server,
    read: (who = actor, requestedPurpose = purpose) => server.read(who, requestedPurpose),
    committed,
    pending,
    loseCreate: () => {
      loseCreate = true;
    },
    loseAck: () => {
      loseAck = true;
    },
    holdAck: () => {
      rejectAck = true;
    },
  };
}

it.each(["project", "duplicate", "class", "import"] as const)(
  "keeps a confirmed %s discoverable while its first UI handoff is held and permits a distinct create after explicit acceptance",
  async (purpose) => {
    const server = await generations(purpose);
    const first = storage(),
      second = storage();
    const key = createOperationKey(actor, purpose);
    const original = {
      path:
        purpose === "class"
          ? "/api/v1/classes"
          : purpose === "duplicate"
            ? `/api/v1/projects/${other}/duplicate`
            : input.path,
      body:
        purpose === "class"
          ? { name: "Museum" }
          : purpose === "duplicate"
            ? { title: "Museum", expectedRevision: 0 }
            : purpose === "import"
              ? { title: "Museum", document: "private import" }
              : input.body,
      ...(purpose === "import" ? { retainBody: false as const, retry: true as const } : {}),
    };
    const verify = (receipt: unknown) => creationReceipt(receipt, purpose);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstResult: WriteResult | undefined;
    const handoff = sendGuardedCreateOperation(
      first,
      key,
      actor,
      server.write,
      verify,
      original,
      server.read,
    ).then(async (result) => {
      firstResult = result;
      reached();
      await held;
      return result;
    });
    await ready;
    expect(firstResult?.kind).toBe("confirmed");
    const saved = readCreateOperation(first, key, actor)!;
    const recovered = await server.read();
    expect(recovered).toMatchObject({
      state: "unacknowledged",
      operationId: saved.body.operationId,
      receipt: saved.receipt,
    });
    expect(server.writes).toHaveLength(1);
    first.removeItem(key);
    expect(
      await sendGuardedCreateOperation(
        second,
        key,
        actor,
        server.write,
        verify,
        original,
        server.read,
      ),
    ).toMatchObject({ kind: "rejected", code: "creation_recovery_required" });
    expect(server.committed.size).toBe(1);
    expect(server.writes).toHaveLength(1);
    expect(
      await acknowledgeCreation(actor, purpose, recovered.operationId!, server.write, server.read),
    ).toEqual({ kind: "confirmed", value: null });
    const next = await sendGuardedCreateOperation(
      second,
      key,
      actor,
      server.write,
      verify,
      original,
      server.read,
    );
    expect(next.kind).toBe("confirmed");
    const distinct = readCreateOperation(second, key, actor)!;
    expect(distinct.body.operationId).not.toBe(saved.body.operationId);
    expect(distinct.body.creationGuard).toEqual({
      purpose,
      previousOperationId: saved.body.operationId,
    });
    expect(server.committed.size).toBe(2);
    release();
    expect(await handoff).toEqual(firstResult);
    expect(await server.read()).toMatchObject({
      state: "unacknowledged",
      operationId: distinct.body.operationId,
    });
    expect(server.writes.filter((request) => request.path.endsWith("/acknowledge"))).toHaveLength(
      1,
    );
  },
);

it("preserves a newer marker and the server receipt when a confirmed response loses the local compare", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const server = await generations("project", () => {
    store.setItem(key, "newer saved request");
  });
  expect(
    await sendGuardedCreateOperation(
      store,
      key,
      actor,
      server.write,
      projectReceipt,
      input,
      server.read,
    ),
  ).toEqual({ kind: "unknown" });
  expect(store.getItem(key)).toBe("newer saved request");
  expect((await server.read()).state).toBe("unacknowledged");
  expect(server.writes).toHaveLength(1);
});

it("leaves the committed generation discoverable if persisting its receipt fails", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const server = await generations("project", () => {
    fillStorage();
  });
  expect(
    await sendGuardedCreateOperation(
      store,
      key,
      actor,
      server.write,
      projectReceipt,
      input,
      server.read,
    ),
  ).toEqual({ kind: "unknown" });
  expect(readCreateOperation(store, key, actor)!.receipt).toBeUndefined();
  expect((await server.read()).state).toBe("unacknowledged");
  expect(server.writes).toHaveLength(1);
});

it("blocks another profile and a lost local key behind the authoritative unacknowledged receipt", async () => {
  const server = await generations();
  server.loseCreate();
  const first = storage(),
    second = storage();
  const key = createOperationKey(actor, "project");
  expect(
    (
      await sendGuardedCreateOperation(
        first,
        key,
        actor,
        server.write,
        projectReceipt,
        input,
        server.read,
      )
    ).kind,
  ).toBe("unknown");
  const original = await server.read();
  expect(original.state).toBe("unacknowledged");
  first.removeItem(key);
  expect(
    await sendGuardedCreateOperation(
      first,
      key,
      actor,
      server.write,
      projectReceipt,
      input,
      server.read,
    ),
  ).toMatchObject({ kind: "rejected", code: "creation_recovery_required" });
  expect(
    await sendGuardedCreateOperation(
      second,
      key,
      actor,
      server.write,
      projectReceipt,
      input,
      server.read,
    ),
  ).toMatchObject({ kind: "rejected", code: "creation_recovery_required" });
  expect(server.writes).toHaveLength(1);
  expect(await server.read()).toEqual(original);
});

it("requires explicit acknowledgement before a deliberately distinct generation and reconciles a dropped ACK", async () => {
  const server = await generations();
  server.loseCreate();
  server.loseAck();
  const first = storage(),
    second = storage();
  const key = createOperationKey(actor, "project");
  await sendGuardedCreateOperation(
    first,
    key,
    actor,
    server.write,
    projectReceipt,
    input,
    server.read,
  );
  const recovered = await server.read();
  expect(
    (await acknowledgeCreation(actor, "project", recovered.operationId!, server.write, server.read))
      .kind,
  ).toBe("confirmed");
  const ready = await server.read();
  expect(ready.state).toBe("ready");
  await sendGuardedCreateOperation(
    second,
    key,
    actor,
    server.write,
    projectReceipt,
    input,
    server.read,
  );
  const creates = server.writes.filter((request) => request.path === input.path);
  expect(creates).toHaveLength(2);
  expect(readField(creates[1]!.body, "operationId")).not.toBe(
    readField(creates[0]!.body, "operationId"),
  );
  expect(readField(creates[1]!.body, "creationGuard")).toEqual({
    purpose: "project",
    previousOperationId: recovered.operationId,
  });
});

it.each([false, true])(
  "preserves the predecessor across a delayed generation race even when all local state is lost: %s",
  async (forget) => {
    const first = storage();
    const key = createOperationKey(actor, "project");
    const started = deferred<void>();
    const release = deferred<void>();
    let received = 0;
    const server = await generations("project", async (body) => {
      if (++received !== 1) return;
      expect(readCreateOperation(first, key, actor)!.body).toEqual(body);
      started.resolve();
      await release.promise;
    });
    const original = sendGuardedCreateOperation(
      first,
      key,
      actor,
      server.write,
      projectReceipt,
      input,
      server.read,
    );
    await started.promise;
    const originalId = readCreateOperation(first, key, actor)!.body.operationId;
    if (forget) first.removeItem(key);
    const parallel = await server.write(actor, input.path, "POST", {
      ...input.body,
      operationId: crypto.randomUUID(),
      creationGuard: { purpose: "project", previousOperationId: null },
    });
    release.resolve();
    expect(parallel.kind).toBe("confirmed");
    expect(await original).toMatchObject({ kind: "rejected", code: "creation_recovery_required" });
    if (forget) expect(first.getItem(key)).toBeNull();
    else expect(readCreateOperation(first, key, actor)!.body.operationId).toBe(originalId);
    expect(server.committed.size).toBe(1);
  },
);

it("keeps a successful import receipt without acknowledging it so recovery needs no original file", async () => {
  const server = await generations();
  server.holdAck();
  const store = storage();
  const key = createOperationKey(actor, "import");
  const imported = {
    ...input,
    retainBody: false as const,
    retry: true as const,
    body: { title: "Museum", document: "private content" },
  };
  expect(
    (
      await sendGuardedCreateOperation(
        store,
        key,
        actor,
        server.write,
        projectReceipt,
        imported,
        server.read,
      )
    ).kind,
  ).toBe("confirmed");
  expect(readCreateOperation(store, key, actor)!.receipt).toBeDefined();
  expect(store.getItem(key)).not.toContain("private content");
  expect(server.pending.size).toBe(1);
  expect(server.writes).toHaveLength(1);
  expect(
    (
      await sendGuardedCreateOperation(
        store,
        key,
        actor,
        server.write,
        projectReceipt,
        undefined,
        server.read,
      )
    ).kind,
  ).toBe("confirmed");
  expect(server.writes.filter((request) => request.path === input.path)).toHaveLength(1);
  expect(server.writes).toHaveLength(1);
  expect(
    (
      await acknowledgeCreation(
        actor,
        "import",
        String(readCreateOperation(store, key, actor)!.body.operationId),
        server.write,
        server.read,
      )
    ).kind,
  ).toBe("unknown");
  expect(readCreateOperation(store, key, actor)!.receipt).toBeDefined();
  expect(server.pending.size).toBe(1);
});

it("fails closed on unavailable or malformed generation discovery, including unchanged legacy keyed retries", async () => {
  const store = storage();
  const server = await serveCreation({ head: () => new Response(null, { status: 404 }) });
  const key = createOperationKey(actor, "project");

  expect(
    (
      await sendGuardedCreateOperation(
        store,
        key,
        actor,
        server.write,
        projectReceipt,
        input,
        server.read,
      )
    ).kind,
  ).toBe("rejected");
  expect(store.getItem(key)).toBeNull();
  const legacy = JSON.stringify({
    actorId: actor,
    path: input.path,
    body: { title: "Museum", operationId: other },
  });
  store.setItem(key, legacy);
  await sendGuardedCreateOperation(
    store,
    key,
    actor,
    server.write,
    projectReceipt,
    undefined,
    server.read,
  );
  expect(store.getItem(key)).toBe(legacy);
  expect(server.writes).toHaveLength(0);
  for (const invalid of [
    {},
    { operationId: null, state: "unacknowledged", receipt: null },
    { operationId: null, state: "ready", receipt: value },
    { operationId: other, state: "unacknowledged", receipt: { id: actor } },
  ])
    expect(() => creationHead(invalid, "project")).toThrow("incompatible");
});

it("replays a legacy keyed request without inventing a guard after proving server compatibility", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const body = { title: "Museum", operationId: other };
  store.setItem(key, JSON.stringify({ actorId: actor, path: input.path, body }));
  const server = await serveCreation({ write: () => Response.json(value) });
  await sendGuardedCreateOperation(
    store,
    key,
    actor,
    server.write,
    projectReceipt,
    undefined,
    server.read,
  );
  expect(server.writes).toEqual([{ actorId: actor, path: input.path, method: "POST", body }]);
  expect(readCreateOperation(store, key, actor)).toEqual({
    actorId: actor,
    path: input.path,
    body,
    receipt: value,
  });
});

it.each([200, 201])(
  "does not close a still-outstanding operation on a raw HTTP %s JSON-null ACK",
  async (status) => {
    const server = await serveCreation({
      write: () => Response.json(null, { status }),
      head: () => Response.json({ state: "unacknowledged", operationId: other, receipt: value }),
    });
    expect(await acknowledgeCreation(actor, "project", other, server.write, server.read)).toEqual({
      kind: "unknown",
    });
    expect(
      server.requests.filter(
        ({ method, url }) =>
          method === "GET" && new URL(url).pathname.endsWith("/creation-operations/project"),
      ),
    ).toHaveLength(1);
    expect((await server.read(actor, "project")).state).toBe("unacknowledged");
  },
);
