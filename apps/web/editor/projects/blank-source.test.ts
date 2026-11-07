import { expect, it, vi } from "vitest";
import { createBlankSource } from "./blank-source";

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
  const first = await createBlankSource(store, write, "teacher", "Museum", "space");
  const second = await createBlankSource(store, write, "teacher", "Museum", "space");
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
  expect(await createBlankSource(store, write, "teacher", "Museum", "space")).toEqual({
    kind: "unknown",
  });
  expect(await createBlankSource(store, write, "teacher", "Museum", "space")).toEqual({
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
  expect(await createBlankSource(store, write, "teacher", "Museum", "space")).toMatchObject({
    kind: "rejected",
  });
  expect(write).not.toHaveBeenCalled();
});
