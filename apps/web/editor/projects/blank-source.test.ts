import { expect, it, vi } from "vitest";
import { createBlankSource } from "./blank-source";
const readCurrent = async () => ({ kind: "available" as const, revision: 0 });

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
  expect(write).toHaveBeenCalledOnce();
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
  expect(write).toHaveBeenCalledWith("teacher", "/api/v1/projects", "POST", { title: "Museum" });
});
