import { expect, it, vi } from "vitest";
import {
  createOperationKey,
  readCreateOperation,
  sendCreateOperation as sendGuardedCreateOperation,
  creationHead,
  acknowledgeCreation,
  type CreationHead,
  releaseCreateOperation,
  duplicateCreateReceipt,
  creationReceipt,
} from "./create-operation";
import { createWorkspaceClient, projectReceipt, type WriteResult } from "./workspace-api";

function sendCreateOperation(...args: Parameters<typeof sendGuardedCreateOperation>) {
  const [store, key, actorId, write, verify, input] = args;
  return sendGuardedCreateOperation(
    store,
    key,
    actorId,
    (account, path, method, body) =>
      path.endsWith("/acknowledge")
        ? Promise.resolve({ kind: "confirmed", value: null })
        : write(account, path, method, body),
    verify,
    input,
    async () => ({ state: "ready", operationId: null, receipt: null }),
  );
}

const actor = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const value = { projectId: other, revision: 0, updatedAt: "2026-11-14T00:00:00Z", archived: false };
const input = { path: "/api/v1/projects", body: { title: "Museum" } };
function storage() {
  const records = new Map<string, string>();
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, raw: string) => {
      records.set(key, raw);
    },
    removeItem: (key: string) => {
      records.delete(key);
    },
  };
}

it("persists before dispatch and replays the original body after a lost reply and reload", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const write = vi.fn(
    async (_actor: string, _path: string, _method: "POST", body: object): Promise<WriteResult> => {
      expect(readCreateOperation(store, key, actor)?.body).toEqual(body);
      return write.mock.calls.length === 1 ? { kind: "unknown" } : { kind: "confirmed", value };
    },
  );
  expect(await sendCreateOperation(store, key, actor, write, projectReceipt, input)).toEqual({
    kind: "unknown",
  });
  const pending = readCreateOperation(store, key, actor);
  expect(pending?.body.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await sendCreateOperation(store, key, actor, write, projectReceipt)).toEqual({
    kind: "confirmed",
    value,
  });
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
  expect(readCreateOperation(store, key, actor)).toEqual({ ...pending, receipt: value });
  expect(await sendCreateOperation(store, key, actor, write, projectReceipt)).toEqual({
    kind: "confirmed",
    value,
  });
  expect(write).toHaveBeenCalledTimes(2);
});

it("keeps a delayed request's identity when an early retry also loses its reply", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  let finish!: (result: WriteResult) => void;
  let sent!: () => void;
  const started = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const write = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async (): Promise<WriteResult> => {
    sent();
    if (write.mock.calls.length === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { kind: "confirmed", value };
  });
  const first = sendCreateOperation(store, key, actor, write, projectReceipt, input);
  await started;
  const pending = readCreateOperation(store, key, actor);
  const retry = sendCreateOperation(store, key, actor, write, projectReceipt);
  finish({ kind: "unknown" });
  await first;
  await retry;
  expect(write.mock.calls[1]?.[3]).toEqual(pending?.body);
});

it("allows deliberate identical new creates after explicit release, and isolates accounts", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const write = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async (): Promise<WriteResult> => ({ kind: "confirmed", value }));
  await sendCreateOperation(store, key, actor, write, projectReceipt, input);
  expect(await sendCreateOperation(store, key, actor, write, projectReceipt, input)).toMatchObject({
    kind: "rejected",
    message: "An earlier creation succeeded. Review and accept its result before starting another.",
  });
  expect(await releaseCreateOperation(store, actor, "project", store.getItem(key)!)).toBe(true);
  await sendCreateOperation(store, key, actor, write, projectReceipt, input);
  expect(write.mock.calls[0]?.[3]).not.toEqual(write.mock.calls[1]?.[3]);
  const lost = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async (): Promise<WriteResult> => ({ kind: "unknown" }));
  await sendCreateOperation(store, key, actor, lost, projectReceipt, input);
  expect(readCreateOperation(store, createOperationKey(other, "project"), other)).toBeNull();
  expect(() => readCreateOperation(store, key, other)).toThrow("verified");
  expect((await sendCreateOperation(store, key, other, write, projectReceipt)).kind).toBe(
    "rejected",
  );
  expect(write).toHaveBeenCalledTimes(2);
});

it("requires the original input for an unresolved operation and retains conflicting or invalid acknowledgements", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const write = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async (): Promise<WriteResult> => ({ kind: "unknown" }));
  await sendCreateOperation(store, key, actor, write, projectReceipt, input);
  expect(
    (
      await sendCreateOperation(store, key, actor, write, projectReceipt, {
        ...input,
        body: { title: "Changed" },
      })
    ).kind,
  ).toBe("rejected");
  expect(write).toHaveBeenCalledOnce();
  write.mockResolvedValue({ kind: "confirmed", value: null });
  expect((await sendCreateOperation(store, key, actor, write, projectReceipt)).kind).toBe(
    "unknown",
  );
  write.mockResolvedValue({ kind: "rejected", code: "operation_conflict", message: "Conflict" });
  await sendCreateOperation(store, key, actor, write, projectReceipt);
  expect(readCreateOperation(store, key, actor)).not.toBeNull();
  write.mockResolvedValue({ kind: "rejected", message: "Sign in again" });
  await sendCreateOperation(store, key, actor, write, projectReceipt);
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
  const write = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async (): Promise<WriteResult> => ({ kind: "unknown" }));
  await sendCreateOperation(store, key, actor, write, projectReceipt, imported);
  expect(store.getItem(key)!.length).toBeLessThan(400);
  await sendCreateOperation(store, key, actor, write, projectReceipt);
  expect(write).toHaveBeenCalledOnce();
  await sendCreateOperation(store, key, actor, write, projectReceipt, {
    ...imported,
    body: { ...imported.body, document: "changed" },
  });
  expect(write).toHaveBeenCalledOnce();
  await sendCreateOperation(store, key, actor, write, projectReceipt, imported);
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
});

it("does not dispatch without verified durable storage or create a new ID when retry data is missing", async () => {
  const store = storage();
  const key = createOperationKey(actor, "project");
  const write = vi.fn();
  await sendCreateOperation(store, key, actor, write, projectReceipt);
  await sendCreateOperation(
    { ...store, setItem: () => {} },
    key,
    actor,
    write,
    projectReceipt,
    input,
  );
  store.setItem(key, "1");
  await sendCreateOperation(store, key, actor, write, projectReceipt, input);
  expect(write).not.toHaveBeenCalled();
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
  const write = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async () => ({ kind: "unknown" }));
  await sendCreateOperation(store, key, actor, write, projectReceipt, copy);
  const observed = store.getItem(key)!;
  const firstId = readCreateOperation(store, key, actor)!.body.operationId;
  write.mockResolvedValue({
    kind: "rejected",
    code: "revision_conflict",
    message: "Source changed",
  });
  await sendCreateOperation(store, key, actor, write, projectReceipt);
  expect(store.getItem(key)).toBe(observed);
  expect(await releaseCreateOperation(store, actor, "duplicate", observed)).toBe(true);
  expect(write).toHaveBeenCalledTimes(2);
  write.mockResolvedValue({ kind: "unknown" });
  await sendCreateOperation(store, key, actor, write, projectReceipt, {
    ...copy,
    body: { ...copy.body, expectedRevision: 1 },
  });
  expect(write).toHaveBeenCalledTimes(3);
  expect(readCreateOperation(store, key, actor)!.body.operationId).not.toBe(firstId);
});

it("rejects copy replay receipts that acknowledge the exact saved source project", async () => {
  const store = storage();
  const key = createOperationKey(actor, "duplicate");
  const copy = {
    path: "/api/v1/projects/" + other + "/duplicate",
    body: { expectedRevision: 0, title: "Copy" },
  };
  const write = vi.fn<
    (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>
  >(async () => ({ kind: "unknown" }));
  await sendCreateOperation(store, key, actor, write, projectReceipt, copy);
  write.mockResolvedValue({ kind: "confirmed", value });
  const outcome = await sendCreateOperation(store, key, actor, write, (receipt) =>
    duplicateCreateReceipt(receipt, readCreateOperation(store, key, actor)),
  );
  expect(outcome.kind).toBe("unknown");
  expect(readCreateOperation(store, key, actor)).not.toBeNull();
  expect(
    duplicateCreateReceipt({ ...value, projectId: actor }, readCreateOperation(store, key, actor)),
  ).toBe(true);
});

function generations() {
  let predecessor: string | null = null;
  const pending = new Map<string, unknown>();
  const committed = new Map<string, { body: object; receipt: unknown }>();
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let loseCreate = false;
  let loseAck = false;
  let rejectAck = false;
  const read = vi.fn(async (): Promise<CreationHead> => {
    const entry = [...pending.entries()].at(-1);
    return entry
      ? { state: "unacknowledged", operationId: entry[0], receipt: entry[1] }
      : { state: "ready", operationId: predecessor, receipt: null };
  });
  const write = vi.fn(
    async (_actor: string, path: string, _method: "POST", body: object): Promise<WriteResult> => {
      const input = body as Record<string, unknown>;
      requests.push({ path, body: input });
      if (path.endsWith("/acknowledge")) {
        if (rejectAck) return { kind: "unknown" };
        pending.delete(path.split("/").at(-2)!);
        return loseAck ? { kind: "unknown" } : { kind: "confirmed", value: null };
      }
      const operationId = String(input.operationId);
      const prior = committed.get(operationId);
      if (prior)
        return JSON.stringify(prior.body) === JSON.stringify(input)
          ? { kind: "confirmed", value: prior.receipt }
          : { kind: "rejected", code: "operation_conflict", message: "Conflict" };
      const guard = input.creationGuard as { purpose: string; previousOperationId: string | null };
      if (pending.size || guard.previousOperationId !== predecessor)
        return { kind: "rejected", code: "creation_state_changed", message: "Generation changed" };
      const receipt =
        path === "/api/v1/classes"
          ? { id: crypto.randomUUID(), organizationId: other, name: input.name }
          : { ...value, projectId: crypto.randomUUID() };
      predecessor = operationId;
      pending.set(operationId, receipt);
      committed.set(operationId, { body: input, receipt });
      return loseCreate ? { kind: "unknown" } : { kind: "confirmed", value: receipt };
    },
  );
  return {
    read,
    write,
    requests,
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
    allowAck: () => {
      rejectAck = false;
    },
  };
}

it.each(["project", "duplicate", "class", "import"] as const)(
  "keeps a confirmed %s discoverable while its first UI handoff is held and permits a distinct create after explicit acceptance",
  async (purpose) => {
    const server = generations();
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
    expect(server.requests).toHaveLength(1);
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
    expect(server.requests).toHaveLength(1);
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
    expect(server.requests.filter((request) => request.path.endsWith("/acknowledge"))).toHaveLength(
      1,
    );
  },
);

it("preserves a newer marker and the server receipt when a confirmed response loses the local compare", async () => {
  const server = generations();
  const store = storage();
  const key = createOperationKey(actor, "project");
  const replaced = vi.fn(async (who: string, path: string, method: "POST", body: object) => {
    const result = await server.write(who, path, method, body);
    store.setItem(key, "newer saved request");
    return result;
  });
  expect(
    await sendGuardedCreateOperation(
      store,
      key,
      actor,
      replaced,
      projectReceipt,
      input,
      server.read,
    ),
  ).toEqual({ kind: "unknown" });
  expect(store.getItem(key)).toBe("newer saved request");
  expect((await server.read()).state).toBe("unacknowledged");
  expect(server.requests).toHaveLength(1);
});

it("leaves the committed generation discoverable if persisting its receipt fails", async () => {
  const server = generations();
  const store = storage();
  const key = createOperationKey(actor, "project");
  const writes = vi
    .fn(store.setItem)
    .mockImplementationOnce(store.setItem)
    .mockImplementation(() => {
      throw new Error("Storage full");
    });
  expect(
    await sendGuardedCreateOperation(
      { ...store, setItem: writes },
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
  expect(server.requests).toHaveLength(1);
});

it("blocks another profile and a lost local key behind the authoritative unacknowledged receipt", async () => {
  const server = generations();
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
  expect(server.requests).toHaveLength(1);
  expect(await server.read()).toEqual(original);
});

it("requires explicit acknowledgement before a deliberately distinct generation and reconciles a dropped ACK", async () => {
  const server = generations();
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
  const creates = server.requests.filter((request) => request.path === input.path);
  expect(creates).toHaveLength(2);
  expect(creates[1]!.body.operationId).not.toBe(creates[0]!.body.operationId);
  expect(creates[1]!.body.creationGuard).toEqual({
    purpose: "project",
    previousOperationId: recovered.operationId,
  });
});

it.each([false, true])(
  "preserves the predecessor across a delayed generation race even when all local state is lost: %s",
  async (forget) => {
    vi.stubGlobal("navigator", {
      locks: { request: async (_key: string, action: () => Promise<unknown>) => action() },
    });
    const server = generations();
    const first = storage(),
      second = storage();
    const key = createOperationKey(actor, "project");
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const delayed = async (
      who: string,
      path: string,
      method: "POST",
      body: object,
    ): Promise<WriteResult> => {
      if (path === input.path) {
        expect(readCreateOperation(first, key, actor)!.body).toEqual(body);
        entered();
        await gate;
      }
      return server.write(who, path, method, body);
    };
    const original = sendGuardedCreateOperation(
      first,
      key,
      actor,
      delayed,
      projectReceipt,
      input,
      server.read,
    );
    await started;
    const originalId = readCreateOperation(first, key, actor)!.body.operationId;
    if (forget) first.removeItem(key);
    await sendGuardedCreateOperation(
      second,
      key,
      actor,
      server.write,
      projectReceipt,
      input,
      server.read,
    );
    resume();
    expect(await original).toMatchObject({ kind: "rejected", code: "creation_recovery_required" });
    if (forget) expect(first.getItem(key)).toBeNull();
    else expect(readCreateOperation(first, key, actor)!.body.operationId).toBe(originalId);
    expect(server.committed.size).toBe(1);
    vi.unstubAllGlobals();
  },
);

it("keeps a successful import receipt without acknowledging it so recovery needs no original file", async () => {
  const server = generations();
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
  expect(server.requests).toHaveLength(1);
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
  expect(server.requests.filter((request) => request.path === input.path)).toHaveLength(1);
  expect(server.requests).toHaveLength(1);
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
  const store = storage(),
    write = vi.fn();
  const key = createOperationKey(actor, "project");
  const unavailable = async (): Promise<CreationHead> => {
    throw new Error("Compatibility GET returned 404");
  };
  expect(
    (await sendGuardedCreateOperation(store, key, actor, write, projectReceipt, input, unavailable))
      .kind,
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
    write,
    projectReceipt,
    undefined,
    unavailable,
  );
  expect(store.getItem(key)).toBe(legacy);
  expect(write).not.toHaveBeenCalled();
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
  const write = vi.fn(async (): Promise<WriteResult> => ({ kind: "confirmed", value }));
  await sendGuardedCreateOperation(
    store,
    key,
    actor,
    write,
    projectReceipt,
    undefined,
    async () => ({ state: "ready", operationId: null, receipt: null }),
  );
  expect(write).toHaveBeenCalledExactlyOnceWith(actor, input.path, "POST", body);
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
    const request = vi.fn<typeof fetch>(async (path) => {
      if (String(path).endsWith("/auth/session"))
        return Response.json({
          userId: actor,
          displayName: "Teacher",
          role: "Educator",
          orgId: other,
          mustChangePassword: false,
        });
      if (String(path).endsWith("/auth/csrf")) return Response.json({ requestToken: "token" });
      return Response.json(null, { status });
    });
    const read = vi.fn(async (): Promise<CreationHead> => ({
      state: "unacknowledged",
      operationId: other,
      receipt: value,
    }));
    expect(
      await acknowledgeCreation(
        actor,
        "project",
        other,
        createWorkspaceClient(request).write,
        read,
      ),
    ).toEqual({ kind: "unknown" });
    expect(read).toHaveBeenCalledOnce();
    expect((await read()).state).toBe("unacknowledged");
  },
);
