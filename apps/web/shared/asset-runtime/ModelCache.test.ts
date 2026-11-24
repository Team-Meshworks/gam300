import { readFile } from "node:fs/promises";
import { URL as FileUrl } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { deferred } from "../../tests/deferred";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { ModelCache } from "./ModelCache";
import type { CatalogueAsset } from "./catalogue";

const bytes = Uint8Array.from(
  await readFile(new FileUrl("../../../../assets/delivery/test-crate.glb", import.meta.url)),
);
const glb = () => new Response(bytes);
let cache: ModelCache;

function descriptor(origin: string): CatalogueAsset {
  return {
    id: "crate-v1",
    name: "Crate",
    kind: "model",
    url: new URL("/crate.glb", origin).href,
    sha256: "a".repeat(64),
    thumbnail: null,
  };
}

function mesh(model: THREE.Group) {
  const object = model.children[0];
  if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.Material)) {
    throw new Error("Expected the crate mesh and material");
  }
  return object;
}

function disposalCount(model: THREE.Group) {
  const object = mesh(model);
  let geometries = 0;
  let materials = 0;
  object.geometry.addEventListener("dispose", () => geometries++);
  object.material.addEventListener("dispose", () => materials++);
  return () => [geometries, materials];
}

function acquire(asset: CatalogueAsset, signal = new AbortController().signal) {
  return cache.acquire(asset, signal);
}

beforeEach(() => {
  vi.useFakeTimers();
  cache = new ModelCache();
});
afterEach(() => {
  cache.invalidate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("coalesces requests and protects other borrowers until their final release", async () => {
  const { origin } = await serveResponses(glb());
  const asset = descriptor(origin);
  const parse = vi.spyOn(GLTFLoader.prototype, "parseAsync");
  const [a, b] = await Promise.all([acquire(asset), acquire(asset)]);
  expect(parse).toHaveBeenCalledOnce();
  expect(a.value).toBe(b.value);
  const disposals = disposalCount(a.value.model);
  a.release();
  a.release();
  cache.invalidate(asset.id);
  expect(disposals()).toEqual([0, 0]);
  b.release();
  b.release();
  expect(disposals()).toEqual([1, 1]);
});

it("evicts both HTTP and parse failures so a retry really loads again", async () => {
  const { origin } = await serveResponses(
    new Response("Unavailable", { status: 503 }),
    new Response(new Uint8Array(20)),
    glb(),
  );
  const asset = descriptor(origin);
  const parse = vi.spyOn(GLTFLoader.prototype, "parseAsync");
  await expect(acquire(asset)).rejects.toThrow("503");
  expect(parse).not.toHaveBeenCalled();
  await expect(acquire(asset)).rejects.toThrow();
  const lease = await acquire(asset);
  expect(lease.value.model.children).toHaveLength(1);
  expect(parse).toHaveBeenCalledTimes(2);
  lease.release();
});

it("cancels one waiter without aborting another, and aborts when no waiters remain", async () => {
  const active = deferred<Request>();
  const completed = deferred<Response>();
  const abandoned = deferred<Request>();
  const stopped = deferred<Response>();
  let requests = 0;
  const { origin } = await serveHttp((request) => {
    requests++;
    if (requests === 1) {
      active.resolve(request);
      return completed.promise;
    }
    if (requests === 2) {
      abandoned.resolve(request);
      return stopped.promise;
    }
    throw new Error("Unexpected model download");
  });
  const asset = descriptor(origin);
  const a = new AbortController();
  const b = new AbortController();
  const pendingA = acquire(asset, a.signal);
  const pendingB = acquire(asset, b.signal);
  try {
    const shared = await active.promise;
    const rejectionA = expect(pendingA).rejects.toMatchObject({ name: "AbortError" });
    a.abort();
    await rejectionA;
    expect(shared.signal.aborted).toBe(false);
    completed.resolve(glb());
    (await pendingB).release();
    cache.invalidate();
    const pending = acquire(asset, b.signal);
    const sole = await abandoned.promise;
    const disconnected = new Promise<void>((resolve) =>
      sole.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    b.abort();
    await rejection;
    await disconnected;
    expect(sole.signal.aborted).toBe(true);
    expect(() => acquire(asset, b.signal)).toThrow();
  } finally {
    completed.resolve(glb());
    stopped.resolve(Response.error());
  }
});

it("disposes a late parse without evicting a newer request with the same key", async () => {
  const bufferRequested = deferred<void>();
  const completeBuffer = deferred<Response>();
  const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  let loads = 0;
  const { origin } = await serveHttp((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/vertices.bin") {
      bufferRequested.resolve();
      return completeBuffer.promise;
    }
    if (++loads !== 1) return glb();
    return Response.json({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }],
      buffers: [{ byteLength: vertices.byteLength, uri: new URL("/vertices.bin", url).href }],
    });
  });
  const asset = descriptor(origin);
  const parse = vi.spyOn(GLTFLoader.prototype, "parseAsync");
  const dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  const controller = new AbortController();
  const pending = acquire(asset, controller.signal);
  try {
    await bufferRequested.promise;
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    const current = await acquire(asset);
    completeBuffer.resolve(new Response(new Uint8Array(vertices.buffer)));
    const late = await parse.mock.results[0]!.value;
    const again = await acquire(asset);
    expect(dispose.mock.contexts).toEqual([mesh(late.scene).geometry]);
    expect(again.value).toBe(current.value);
    expect(loads).toBe(2);
    current.release();
    again.release();
  } finally {
    completeBuffer.resolve(Response.error());
  }
});

it("keys immutable IDs, content hashes, delivery URLs and placement; invalidation reacquires", async () => {
  const { origin } = await serveResponses(glb(), glb(), glb(), glb(), glb(), glb());
  const asset = descriptor(origin);
  const original = await acquire(asset);
  const variants = [
    { ...asset, id: "crate-v2" },
    { ...asset, sha256: "b".repeat(64) },
    { ...asset, url: new URL("/crate-new.glb", origin).href },
    { ...asset, placement: "bottom-center" as const },
  ];
  for (const variant of variants) {
    const other = await acquire(variant);
    expect(other.value).not.toBe(original.value);
    other.release();
  }
  cache.invalidate(asset.id);
  const reloaded = await acquire(asset);
  expect(reloaded.value).not.toBe(original.value);
  original.release();
  reloaded.release();
});

it("retains at most three idle models and resets the 30-second expiry on reuse", async () => {
  const { origin } = await serveResponses(glb(), glb(), glb(), glb());
  const asset = descriptor(origin);
  const disposals: (() => number[])[] = [];
  for (let index = 0; index < 4; index++) {
    const lease = await acquire({ ...asset, id: `crate-${index}` });
    disposals.push(disposalCount(lease.value.model));
    lease.release();
  }
  expect(disposals[0]?.()).toEqual([1, 1]);
  expect(disposals[1]?.()).toEqual([0, 0]);
  vi.advanceTimersByTime(29_999);
  const warm = await acquire({ ...asset, id: "crate-1" });
  warm.value.thumbnail = "cached-thumbnail";
  warm.release();
  vi.advanceTimersByTime(1);
  expect(disposals[1]?.()).toEqual([0, 0]);
  expect(disposals[2]?.()).toEqual([1, 1]);
  const again = await acquire({ ...asset, id: "crate-1" });
  expect(again.value.thumbnail).toBe("cached-thumbnail");
  again.release();
  vi.advanceTimersByTime(30_000);
  expect(disposals[1]?.()).toEqual([1, 1]);
});

it("keeps acquired resources beyond idle expiry", async () => {
  const { origin } = await serveResponses(glb());
  const lease = await acquire(descriptor(origin));
  const disposals = disposalCount(lease.value.model);
  vi.advanceTimersByTime(60_000);
  expect(disposals()).toEqual([0, 0]);
  lease.release();
  cache.invalidate();
  cache.invalidate();
  expect(disposals()).toEqual([1, 1]);
});

it("reuses verified parses without issuing a request or applying the placement twice", async () => {
  const { origin } = await serveHttp(() => {
    throw new Error("Unexpected model download");
  });
  const model = new THREE.Group();
  const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  model.add(object);
  const parseVerified = vi.fn(async () => model);
  const asset = { ...descriptor(origin), placement: "bottom-center" as const };
  const signal = new AbortController().signal;
  const first = await cache.acquire(asset, signal, parseVerified);
  first.release();
  const second = await cache.acquire(asset, signal, parseVerified);
  expect(second.value.model).toBe(model);
  expect(model.position.y).toBe(0.5);
  expect(parseVerified).toHaveBeenCalledTimes(1);
  second.release();
});

it("evicts large idle models by decoded size and never evicts an active borrower", async () => {
  const models = ["active", "old", "recent"].map((id) => {
    const model = new THREE.Group();
    const texture = new THREE.Texture({ width: 4096, height: 4096 });
    model.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: texture })));
    return { id, model, disposals: disposalCount(model) };
  });
  const signal = new AbortController().signal;
  const [active, old, recent] = await Promise.all(
    models.map(({ id, model }) =>
      cache.acquire({ ...descriptor("http://localhost"), id }, signal, async () => model),
    ),
  );
  old!.release();
  recent!.release();
  expect(models.map(({ disposals }) => disposals())).toEqual([[0, 0], [1, 1], [0, 0]]);
  active!.release();
});
