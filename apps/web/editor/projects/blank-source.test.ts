import { expect, it, vi } from "vitest";
import { blankSourceKey, clearBlankSource, createBlankSource } from "./blank-source";
const readCurrent = async () => ({ kind: "available" as const, revision: 0 });

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
