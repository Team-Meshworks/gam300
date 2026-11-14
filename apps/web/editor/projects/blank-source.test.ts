import { expect, it, vi } from "vitest";
import {
  blankSourceKey,
  historicalBlankSource,
  uncorrelatedBlankSource,
  selectedExistingSource,
  selectExistingSource,
  verifySelectedSource,
  adoptBlankSource,
  adoptedBlankSource,
  clearBlankSource,
  createBlankSource as createGuardedBlankSource,
} from "./blank-source";
function createBlankSource(...args: Parameters<typeof createGuardedBlankSource>) {
  const [store, write, actorId, title, environment, read, image] = args;
  return createGuardedBlankSource(
    store,
    (account, path, method, body) =>
      path.endsWith("/acknowledge")
        ? Promise.resolve({ kind: "confirmed", value: null })
        : write(account, path, method, body),
    actorId,
    title,
    environment,
    read,
    image,
    async () => ({ state: "ready", operationId: null, receipt: null }),
  );
}
const readCurrent = async () => ({ kind: "available" as const, revision: 0 });

it("keeps the form retryable when the browser cannot store the first source marker", async () => {
  const store = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Storage full", "QuotaExceededError");
    },
    removeItem: vi.fn(),
  };
  const write = vi.fn();
  const result = await createBlankSource(store, write, "teacher", "Museum", "", readCurrent);
  expect(write).not.toHaveBeenCalled();
  expect(result).toEqual({
    kind: "rejected",
    message:
      "The browser could not save recovery information. Check browser storage and try again.",
  });
});

it("clears only the confirmed assignment's source and preserves a replacement receipt", async () => {
  const actor = "teacher";
  const older = "aefea67c-caca-4300-923c-937f1c785578";
  const replacement = "15c0fbe1-a338-4030-9360-b04c494d6588";
  const records = new Map<string, string>();
  const store = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
    removeItem: (key: string) => records.delete(key),
  };
  const fresh = JSON.stringify({
    receipt: {
      projectId: replacement,
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  records.set(blankSourceKey(actor), fresh);
  expect(await clearBlankSource(store, actor, { projectId: older })).toBe(false);
  expect(store.getItem(blankSourceKey(actor))).toBe(fresh);
  expect(await clearBlankSource(store, actor, { projectId: replacement })).toBe(true);
  expect(store.getItem(blankSourceKey(actor))).toBeNull();
});

it("rechecks a confirmed source and uses its current revision on retry", async () => {
  const saved = JSON.stringify({
    receipt: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  const store = { getItem: () => saved, setItem: vi.fn(), removeItem: vi.fn() };
  const write = vi.fn();
  const read = vi.fn(async () => ({ kind: "available" as const, revision: 3 }));
  expect(await createBlankSource(store, write, "teacher", "Museum", "", read)).toEqual({
    kind: "confirmed",
    projectId: "aefea67c-caca-4300-923c-937f1c785578",
    revision: 3,
  });
  expect(read).toHaveBeenCalledWith("teacher", "aefea67c-caca-4300-923c-937f1c785578");
  expect(write).not.toHaveBeenCalled();
});

it("preserves the receipt and offers recovery when a source is no longer available", async () => {
  const saved = JSON.stringify({
    receipt: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  const store = { getItem: () => saved, setItem: vi.fn(), removeItem: vi.fn() };
  const write = vi.fn();
  const read = vi.fn(async () => ({ kind: "unavailable" as const }));
  expect(await createBlankSource(store, write, "teacher", "Museum", "", read)).toEqual({
    kind: "source-unavailable",
  });
  expect(store.removeItem).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("keeps the receipt when the source cannot be checked temporarily", async () => {
  const saved = JSON.stringify({
    receipt: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  const store = { getItem: () => saved, setItem: vi.fn(), removeItem: vi.fn() };
  const write = vi.fn();
  const read = vi.fn(async () => ({ kind: "retry" as const }));
  expect(await createBlankSource(store, write, "teacher", "Museum", "", read)).toMatchObject({
    kind: "rejected",
    message: expect.stringMatching(/could not be checked/i),
  });
  expect(store.removeItem).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("reuses the confirmed source after an assignment failure instead of creating another", async () => {
  const storage = new Map<string, string>();
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const write = vi.fn(async () => ({
    kind: "confirmed" as const,
    value: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  }));
  const first = await createBlankSource(store, write, "teacher", "Museum", "space", readCurrent);
  const second = await createBlankSource(store, write, "teacher", "Museum", "space", readCurrent);
  expect(first).toEqual({
    kind: "confirmed",
    projectId: "aefea67c-caca-4300-923c-937f1c785578",
    revision: 0,
  });
  expect(second).toEqual(first);
  expect(write).toHaveBeenCalledOnce();
});

it("never sends a duplicate when the source creation outcome is uncertain", async () => {
  const storage = new Map<string, string>();
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const write = vi.fn(async () => ({ kind: "unknown" as const }));
  expect(await createBlankSource(store, write, "teacher", "Museum", "space", readCurrent)).toEqual({
    kind: "unknown",
  });
  expect(await createBlankSource(store, write, "teacher", "Museum", "space", readCurrent)).toEqual({
    kind: "unknown",
  });
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
});

it("does not send creation if the recovery marker cannot be verified", async () => {
  let reads = 0;
  const store = {
    getItem: () => (++reads === 1 ? null : "unexpected"),
    setItem: () => {},
    removeItem: () => {},
  };
  const write = vi.fn(async () => ({ kind: "unknown" as const }));
  expect(
    await createBlankSource(store, write, "teacher", "Museum", "space", readCurrent),
  ).toMatchObject({
    kind: "rejected",
  });
  expect(write).not.toHaveBeenCalled();
});

it("creates an empty source without sending an environment asset", async () => {
  const storage = new Map<string, string>();
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const write = vi.fn(async () => ({
    kind: "confirmed" as const,
    value: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  }));
  const result = await createBlankSource(store, write, "teacher", "Museum", "", readCurrent);
  expect(result.kind).toBe("confirmed");
  expect(write).toHaveBeenCalledWith("teacher", "/api/v1/projects", "POST", {
    title: "Museum",
    operationId: expect.any(String),
    creationGuard: { purpose: "assignment-source", previousOperationId: null },
  });
});

it("sends an image atomically and refuses to reuse a source with a different image", async () => {
  let stored: string | null = null;
  const store = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
    removeItem: () => {
      stored = null;
    },
  };
  const write = vi.fn(async () => ({
    kind: "confirmed" as const,
    value: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  }));
  const image = { type: "cover" as const, contentType: "image/png", data: "aW1hZ2U=" };
  expect(
    (await createBlankSource(store, write, "teacher", "Museum", "", readCurrent, image)).kind,
  ).toBe("confirmed");
  expect(write).toHaveBeenCalledWith("teacher", "/api/v1/projects", "POST", {
    operationId: expect.any(String),
    creationGuard: { purpose: "assignment-source", previousOperationId: null },
    title: "Museum",
    image,
  });
  expect(
    (await createBlankSource(store, write, "teacher", "Museum", "", readCurrent, image)).kind,
  ).toBe("confirmed");
  expect(
    (
      await createBlankSource(store, write, "teacher", "Museum", "", readCurrent, {
        ...image,
        data: "ZGlmZmVyZW50",
      })
    ).kind,
  ).toBe("image-mismatch");
  expect(write).toHaveBeenCalledOnce();
  expect(stored).not.toContain(image.data);
});

it("does not reuse an image-bearing source when a failed assignment is reopened without an image", async () => {
  let stored: string | null = null;
  const store = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
    removeItem: vi.fn(),
  };
  const write = vi.fn(async () => ({
    kind: "confirmed" as const,
    value: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  }));
  const read = vi.fn(readCurrent);
  const image = { type: "cover" as const, contentType: "image/png", data: "aW1hZ2U=" };
  expect((await createBlankSource(store, write, "teacher", "Museum", "", read, image)).kind).toBe(
    "confirmed",
  );
  // A rejected assignment retains this confirmed source receipt for the next attempt.
  const receipt = stored;
  expect(await createBlankSource(store, write, "teacher", "Museum", "", read)).toEqual({
    kind: "image-mismatch",
  });
  expect(stored).toBe(receipt);
  expect(store.removeItem).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledOnce();
});

it("retains legacy attempt markers without replaying an operation the server never received", async () => {
  const marker = JSON.stringify({
    attemptId: "11111111-1111-4111-8111-111111111111",
    title: "Museum",
    environmentAssetId: "",
  });
  const write = vi.fn();
  const store = { getItem: () => marker, setItem: vi.fn(), removeItem: vi.fn() };
  expect(await createBlankSource(store, write, "teacher", "Museum", "", readCurrent)).toEqual({
    kind: "unknown",
  });
  expect(write).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled();
  expect(store.setItem).not.toHaveBeenCalled();
});

it("replays a pending source only with identical title and image and keeps the image out of storage", async () => {
  const records = new Map<string, string>();
  const store = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
    removeItem: (key: string) => {
      records.delete(key);
    },
  };
  const write = vi.fn(async () => ({ kind: "unknown" as const }));
  const image = { type: "cover" as const, contentType: "image/png", data: "secret image" };
  await createBlankSource(store, write, "teacher", "Museum", "", readCurrent, image);
  const marker = store.getItem(blankSourceKey("teacher"));
  expect(marker).not.toContain(image.data);
  expect(
    (await createBlankSource(store, write, "teacher", "Changed", "", readCurrent, image)).kind,
  ).toBe("rejected");
  expect((await createBlankSource(store, write, "teacher", "Museum", "", readCurrent)).kind).toBe(
    "rejected",
  );
  expect(write).toHaveBeenCalledOnce();
  await createBlankSource(store, write, "teacher", "Museum", "", readCurrent, image);
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
  await createBlankSource(store, write, "other", "Museum", "", readCurrent, image);
  expect(write.mock.calls[2]).not.toEqual(write.mock.calls[0]);
});

it("does not dispatch or mint a source operation when generation discovery is unsupported", async () => {
  const store = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  const write = vi.fn();
  const result = await createGuardedBlankSource(
    store,
    write,
    "teacher",
    "Museum",
    "",
    readCurrent,
    undefined,
    async () => {
      throw new Error("Creation recovery is incompatible or unavailable");
    },
  );
  expect(result).toMatchObject({
    kind: "rejected",
    message: expect.stringMatching(/incompatible/),
  });
  expect(write).not.toHaveBeenCalled();
  expect(store.setItem).not.toHaveBeenCalled();
});

it("replays a pre-generation keyed source exactly without attaching a new creation guard", async () => {
  let raw: string | null = JSON.stringify({
    operationId: "11111111-1111-4111-8111-111111111111",
    title: "Museum",
    environmentAssetId: "",
  });
  const store = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
    removeItem: () => {
      raw = null;
    },
  };
  const write = vi.fn(async () => ({ kind: "unknown" as const }));
  await createGuardedBlankSource(
    store,
    write,
    "teacher",
    "Museum",
    "",
    readCurrent,
    undefined,
    async () => ({ state: "ready", operationId: null, receipt: null }),
  );
  expect(write).toHaveBeenCalledExactlyOnceWith("teacher", "/api/v1/projects", "POST", {
    operationId: "11111111-1111-4111-8111-111111111111",
    title: "Museum",
  });
  expect(raw).not.toContain("creationGuard");
});

it("durably adopts the verified source before acknowledgement and restores it without the image", async () => {
  const actor = "11111111-1111-4111-8111-111111111111";
  const operationId = "22222222-2222-4222-8222-222222222222";
  const receipt = {
    projectId: "33333333-3333-4333-8333-333333333333",
    revision: 0,
    archived: false,
    updatedAt: "2026-11-14T00:00:00Z",
  };
  let record: string | null = null;
  const store = {
    getItem: () => record,
    setItem: (_key: string, value: string) => {
      record = value;
    },
    removeItem: () => {
      record = null;
    },
  };
  await adoptBlankSource(store, actor, null, operationId, receipt, {
    projectId: receipt.projectId,
    title: "Adopted source",
    revision: 4,
  });
  expect(adoptedBlankSource(record!, actor)).toEqual({
    projectId: receipt.projectId,
    title: "Adopted source",
    revision: 4,
    operationId,
  });
  expect(adoptedBlankSource(record!, operationId)).toBeNull();
  const write = vi.fn(async () => ({ kind: "confirmed" as const, value: null }));
  expect(
    await createGuardedBlankSource(
      store,
      write,
      actor,
      "Assignment",
      "",
      readCurrent,
      undefined,
      async () => ({ state: "ready", operationId, receipt: null }),
    ),
  ).toMatchObject({ kind: "confirmed", projectId: receipt.projectId });
  expect(write).toHaveBeenCalledExactlyOnceWith(
    actor,
    "/api/v1/creation-operations/assignment-source/" + operationId + "/acknowledge",
    "POST",
    {},
  );
  expect(record).not.toBeNull();
  const preserved = record;
  const outage = vi.fn(async () => ({ kind: "unknown" as const }));
  expect(
    await createGuardedBlankSource(
      store,
      outage,
      actor,
      "Assignment",
      "",
      readCurrent,
      undefined,
      async () => ({ state: "unacknowledged", operationId, receipt }),
    ),
  ).toEqual({ kind: "unknown" });
  expect(outage).toHaveBeenCalledExactlyOnceWith(
    actor,
    "/api/v1/creation-operations/assignment-source/" + operationId + "/acknowledge",
    "POST",
    {},
  );
  expect(record).toBe(preserved);
  expect(adoptedBlankSource(record!, actor)?.projectId).toBe(receipt.projectId);
  expect(await clearBlankSource(store, actor, { projectId: receipt.projectId })).toBe(true);
});

it("never overwrites a changed or different pending source during explicit adoption, and preserves storage failure", async () => {
  const actor = "11111111-1111-4111-8111-111111111111";
  const operationId = "22222222-2222-4222-8222-222222222222";
  const receipt = {
    projectId: "33333333-3333-4333-8333-333333333333",
    revision: 0,
    archived: false,
    updatedAt: "2026-11-14T00:00:00Z",
  };
  const source = { projectId: receipt.projectId, title: "Source", revision: 0 };
  const original = JSON.stringify({ operationId: actor, title: "Different pending source" });
  const store = { getItem: () => original, setItem: vi.fn(), removeItem: vi.fn() };
  await expect(adoptBlankSource(store, actor, null, operationId, receipt, source)).rejects.toThrow(
    "changed in another tab",
  );
  await expect(
    adoptBlankSource(store, actor, original, operationId, receipt, source),
  ).rejects.toThrow("different source request");
  expect(store.setItem).not.toHaveBeenCalled();
  const unavailable = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Storage full", "QuotaExceededError");
    },
    removeItem: vi.fn(),
  };
  await expect(
    adoptBlankSource(unavailable, actor, null, operationId, receipt, source),
  ).rejects.toThrow("preserve the recovered source");
});

it("distinguishes an uncorrelated historical attempt from a known receipt and never infers a resource from attemptId", () => {
  const attempt = JSON.stringify({
    attemptId: "11111111-1111-4111-8111-111111111111",
    title: "Museum",
    environmentAssetId: "",
  });
  const receipt = JSON.stringify({
    receipt: {
      projectId: "22222222-2222-4222-8222-222222222222",
      revision: 0,
      archived: false,
      updatedAt: "2026-11-14T00:00:00Z",
    },
  });
  expect(historicalBlankSource(attempt)).toBe(true);
  expect(uncorrelatedBlankSource(attempt)).toBe(true);
  expect(historicalBlankSource(receipt)).toBe(true);
  expect(uncorrelatedBlankSource(receipt)).toBe(false);
  expect(selectedExistingSource(attempt, "actor")).toBeNull();
  for (const value of [
    "{",
    "{}",
    JSON.stringify({
      operationId: "11111111-1111-4111-8111-111111111111",
      title: "Museum",
      environmentAssetId: "",
    }),
  ])
    expect(historicalBlankSource(value)).toBe(false);
});
it("persists explicit existing selection at current revision without creation provenance or ACK and preserves stale-choice failures", async () => {
  const actor = "11111111-1111-4111-8111-111111111111";
  const source = {
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Equal title",
    revision: 7,
  };
  let record: string | null = JSON.stringify({
    attemptId: actor,
    title: "Equal title",
    environmentAssetId: "",
  });
  const original = record;
  const store = {
    getItem: () => record,
    setItem: (_key: string, value: string) => {
      record = value;
    },
    removeItem: () => {
      record = null;
    },
  };
  const verify = vi.fn(async () => {});
  const selected = await selectExistingSource(store, actor, original, source, verify);
  expect(JSON.parse(selected)).toEqual({ actorId: actor, selectedExisting: source });
  expect(selectedExistingSource(selected, actor)).toEqual(source);
  expect(selectedExistingSource(selected, source.projectId)).toBeNull();
  expect(verifySelectedSource(store, actor, selected, source)).toEqual(source);
  const write = vi.fn();
  expect(
    await createBlankSource(store, write, actor, "Assignment", "", async () => ({
      kind: "available",
      revision: 7,
    })),
  ).toEqual({ kind: "confirmed", projectId: source.projectId, revision: 7 });
  expect(
    (
      await createBlankSource(store, write, actor, "Assignment", "", async () => ({
        kind: "available",
        revision: 8,
      }))
    ).kind,
  ).toBe("rejected");
  expect(write).not.toHaveBeenCalled();
  expect(record).toBe(selected);
  record = JSON.stringify({ actorId: actor, selectedExisting: { ...source, revision: 8 } });
  expect(() => verifySelectedSource(store, actor, selected, source)).toThrow(
    "changed or was removed",
  );
  await expect(selectExistingSource(store, actor, selected, source, verify)).rejects.toThrow(
    "changed in another tab",
  );
  record = null;
  expect(() => verifySelectedSource(store, actor, selected, source)).toThrow(
    "changed or was removed",
  );
});
it("never replaces a modern source operation or unreadable marker with an existing project choice", async () => {
  const actor = "11111111-1111-4111-8111-111111111111";
  const source = {
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Source",
    revision: 7,
  };
  for (const record of [
    "{",
    JSON.stringify({ operationId: actor, title: "Pending", environmentAssetId: "" }),
  ]) {
    const store = { getItem: () => record, setItem: vi.fn(), removeItem: vi.fn() };
    await expect(
      selectExistingSource(store, actor, record, source, async () => {}),
    ).rejects.toThrow("existing saved source operation");
    expect(store.setItem).not.toHaveBeenCalled();
  }
  const known = JSON.stringify({
    receipt: { projectId: actor, revision: 0, archived: false, updatedAt: "2026-11-14T00:00:00Z" },
  });
  const knownStore = { getItem: () => known, setItem: vi.fn(), removeItem: vi.fn() };
  await expect(
    selectExistingSource(knownStore, actor, known, source, async () => {}),
  ).rejects.toThrow("receipt identifies a different project");
  expect(knownStore.setItem).not.toHaveBeenCalled();
});

it("allows explicit reselection from a valid same-actor manual choice while retaining exact-value CAS", async () => {
  const actor = "11111111-1111-4111-8111-111111111111";
  const source = { projectId: "22222222-2222-4222-8222-222222222222", title: "First", revision: 7 };
  const replacement = {
    projectId: "33333333-3333-4333-8333-333333333333",
    title: "Second",
    revision: 4,
  };
  let record: string | null = null;
  const store = {
    getItem: () => record,
    setItem: (_key: string, value: string) => {
      record = value;
    },
    removeItem: () => {
      record = null;
    },
  };
  const first = await selectExistingSource(store, actor, null, source, async () => {});
  const second = await selectExistingSource(store, actor, first, replacement, async () => {});
  expect(selectedExistingSource(second, actor)).toEqual(replacement);
  await expect(selectExistingSource(store, actor, first, source, async () => {})).rejects.toThrow(
    "Reload",
  );
  expect(record).toBe(second);
  await expect(
    selectExistingSource(store, actor, second, source, async () => {
      throw new Error("Earlier assignment pending");
    }),
  ).rejects.toThrow("Earlier assignment pending");
  expect(record).toBe(second);
});
