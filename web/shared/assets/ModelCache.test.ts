import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ModelCache } from "./ModelCache";
import type { CatalogueAsset } from "./catalogue";

const asset: CatalogueAsset = {
  id: "crate-v1",
  name: "Crate",
  kind: "model",
  url: "/crate.glb",
  sha256: "a".repeat(64),
  thumbnail: null,
};
let cache: ModelCache;
let fetchModel: ReturnType<typeof vi.fn<typeof fetch>>;
let parse: MockInstance<GLTFLoader["parseAsync"]>;

function model() {
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Group();
  scene.add(mesh, mesh.clone());
  const disposed = [geometry, material, texture].map((resource) => vi.spyOn(resource, "dispose"));
  return { gltf: { scene } as GLTF, scene, disposed, texture };
}
function acquire(descriptor = asset, signal = new AbortController().signal) {
  return cache.acquire(descriptor, signal);
}

beforeEach(() => {
  vi.useFakeTimers();
  cache = new ModelCache();
  fetchModel = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(new ArrayBuffer(0)));
  vi.stubGlobal("fetch", fetchModel);
  parse = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockImplementation(async () => model().gltf);
});
afterEach(() => {
  cache.invalidate();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("coalesces requests, preserves independent transforms and protects other borrowers", async () => {
  const loaded = model();
  parse.mockResolvedValue(loaded.gltf);
  const [a, b] = await Promise.all([acquire(), acquire()]);
  expect(fetchModel).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(a.value).toBe(b.value);
  const first = a.value.model.clone(true);
  const second = b.value.model.clone(true);
  first.position.x = 9;
  expect(second.position.x).toBe(0);
  expect(loaded.scene.position.x).toBe(0);
  a.value.thumbnail = "data:image/png;base64,test";
  a.release();
  a.release();
  cache.invalidate(asset.id);
  expect(loaded.disposed.every((dispose) => dispose.mock.calls.length === 0)).toBe(true);
  b.release();
  b.release();
  expect(loaded.disposed.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
});

it("evicts both HTTP and parse failures so a retry really loads again", async () => {
  fetchModel.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
  await expect(acquire()).rejects.toThrow("503");
  parse.mockRejectedValueOnce(new Error("Invalid GLB"));
  await expect(acquire()).rejects.toThrow("Invalid GLB");
  const lease = await acquire();
  expect(fetchModel).toHaveBeenCalledTimes(3);
  expect(parse).toHaveBeenCalledTimes(2);
  lease.release();
});

it("cancels one waiter without aborting another, and aborts when no waiters remain", async () => {
  let finish: (response: Response) => void = () => {};
  fetchModel.mockImplementation(
    (_url, init) =>
      new Promise((resolve, reject) => {
        finish = resolve;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  const a = new AbortController();
  const b = new AbortController();
  const pendingA = acquire(asset, a.signal);
  const pendingB = acquire(asset, b.signal);
  const rejectionA = expect(pendingA).rejects.toMatchObject({ name: "AbortError" });
  a.abort();
  await rejectionA;
  expect(fetchModel.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  finish(new Response(new ArrayBuffer(0)));
  (await pendingB).release();
  cache.invalidate();
  const pending = acquire(asset, b.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  b.abort();
  await rejection;
  expect(fetchModel.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  expect(() => acquire(asset, b.signal)).toThrow();
});

it("disposes a late parse without evicting a newer request with the same key", async () => {
  const late = model();
  let finish: (gltf: GLTF) => void = () => {};
  const started = new Promise<void>((resolve) => {
    parse.mockImplementationOnce(() => {
      resolve();
      return new Promise((resolveParse) => {
        finish = resolveParse;
      });
    });
  });
  const controller = new AbortController();
  const pending = acquire(asset, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await started;
  controller.abort();
  await rejection;
  const current = await acquire();
  finish(late.gltf);
  await vi.waitFor(() =>
    expect(late.disposed.every((dispose) => dispose.mock.calls.length === 1)).toBe(true),
  );
  const again = await acquire();
  expect(again.value).toBe(current.value);
  expect(fetchModel).toHaveBeenCalledTimes(2);
  current.release();
  again.release();
});

it("keys immutable IDs, content hashes, delivery URLs and placement; invalidation reacquires", async () => {
  const original = await acquire();
  const variants = [
    { ...asset, id: "crate-v2" },
    { ...asset, sha256: "b".repeat(64) },
    { ...asset, url: "/crate-new.glb" },
    { ...asset, placement: "bottom-center" as const },
  ];
  for (const variant of variants) {
    const other = await acquire(variant);
    expect(other.value).not.toBe(original.value);
    other.release();
  }
  cache.invalidate(asset.id);
  const reloaded = await acquire();
  expect(reloaded.value).not.toBe(original.value);
  expect(fetchModel).toHaveBeenCalledTimes(6);
  original.release();
  reloaded.release();
});

it("retains at most three idle models and resets the 30-second expiry on reuse", async () => {
  const loaded = Array.from({ length: 4 }, () => model());
  for (const [i, item] of loaded.entries()) {
    parse.mockResolvedValueOnce(item.gltf);
    (await acquire({ ...asset, id: `crate-${i}` })).release();
  }
  expect(loaded[0]?.disposed[0]).toHaveBeenCalledTimes(1);
  expect(loaded[1]?.disposed[0]).not.toHaveBeenCalled();
  vi.advanceTimersByTime(29_999);
  const warm = await acquire({ ...asset, id: "crate-1" });
  warm.value.thumbnail = "cached-thumbnail";
  warm.release();
  vi.advanceTimersByTime(1);
  expect(loaded[1]?.disposed[0]).not.toHaveBeenCalled();
  expect(loaded[2]?.disposed[0]).toHaveBeenCalledTimes(1);
  const again = await acquire({ ...asset, id: "crate-1" });
  expect(again.value.thumbnail).toBe("cached-thumbnail");
  again.release();
  vi.advanceTimersByTime(30_000);
  expect(loaded[1]?.disposed[0]).toHaveBeenCalledTimes(1);
  expect(fetchModel).toHaveBeenCalledTimes(4);
});

it("keeps acquired resources beyond idle expiry and closes a shared bitmap exactly once", async () => {
  class Bitmap {
    close = vi.fn();
  }
  vi.stubGlobal("ImageBitmap", Bitmap);
  const bitmap = new Bitmap();
  const loaded = model();
  loaded.texture.source.data = bitmap;
  parse.mockResolvedValue(loaded.gltf);
  const lease = await acquire();
  vi.advanceTimersByTime(60_000);
  expect(bitmap.close).not.toHaveBeenCalled();
  lease.release();
  cache.invalidate();
  cache.invalidate();
  expect(bitmap.close).toHaveBeenCalledTimes(1);
  expect(loaded.disposed.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
});
