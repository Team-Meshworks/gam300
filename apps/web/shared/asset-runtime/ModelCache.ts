import { combineAbortSignals } from "../network/abort-signals";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CatalogueAsset } from "./catalogue";

const IDLE_MS = 30_000;
const MAX_IDLE_MODELS = 3;
const MAX_IDLE_BYTES = 128 * 1024 * 1024;

type LoadedModel = { readonly model: THREE.Group; thumbnail: string | undefined };
type Entry = {
  assetId: string;
  controller: AbortController;
  promise: Promise<LoadedModel>;
  value: LoadedModel | undefined;
  estimatedBytes?: number;
  users: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type ModelLease = { readonly value: LoadedModel; release(): void };

/** Owns immutable model resources; callers clone nodes and release each acquired lease */
export class ModelCache {
  private readonly entries = new Map<string, Entry>();

  acquire(asset: CatalogueAsset, signal: AbortSignal, load = loadModel): Promise<ModelLease> {
    signal.throwIfAborted();
    const key = JSON.stringify([asset.id, asset.sha256, asset.url, asset.placement ?? null]);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      const created: Entry = {
        assetId: asset.id,
        controller,
        users: 0,
        timer: undefined,
        value: undefined,
        promise: load(asset, controller.signal)
          .then((model) => {
            // Parsing cannot be aborted; reclaim its late result after the last waiter cancels
            if (controller.signal.aborted) {
              disposeModels(model);
              controller.signal.throwIfAborted();
            }
            if (asset.placement === "bottom-center") {
              const box = new THREE.Box3().setFromObject(model);
              const center = box.getCenter(new THREE.Vector3());
              model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
            }
            const value = { model, thumbnail: undefined };
            created.value = value;
            return value;
          })
          .catch((error: unknown) => {
            if (this.entries.get(key) === created) {
              this.entries.delete(key);
            }
            throw error;
          }),
      };
      entry = created;
      this.entries.set(key, entry);
    }
    const acquired = entry;
    clearTimeout(acquired.timer);
    acquired.timer = undefined;
    acquired.users++;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.release(key, acquired);
    };
    return new Promise((resolve, reject) => {
      const abort = () => {
        release();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      acquired.promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (!released) {
            resolve({ value, release });
          }
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          release();
          reject(error);
        },
      );
    });
  }

  /** Retires lookup entries immediately; existing borrowers keep resources until release */
  invalidate(assetId?: string): void {
    for (const [key, entry] of this.entries) {
      if (assetId === undefined || entry.assetId === assetId) {
        this.evict(key, entry);
      }
    }
  }

  private evict(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    clearTimeout(entry.timer);
    if (entry.users === 0) {
      entry.controller.abort();
      if (entry.value !== undefined) {
        disposeModels(entry.value.model);
      }
    }
  }

  private release(key: string, entry: Entry): void {
    if (--entry.users !== 0) {
      return;
    }
    if (entry.value === undefined || this.entries.get(key) !== entry) {
      this.evict(key, entry);
      return;
    }
    // Map insertion order records the last release, so idle eviction is least-recently-used
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.timer = setTimeout(() => this.evict(key, entry), IDLE_MS);
    entry.estimatedBytes ??= estimateModelBytes(entry.value.model);
    if (entry.estimatedBytes > MAX_IDLE_BYTES) {
      this.evict(key, entry);
      return;
    }
    const idle = [...this.entries].filter(([, candidate]) => candidate.users === 0);
    let idleBytes = idle.reduce((sum, [, candidate]) => sum + (candidate.estimatedBytes ?? 0), 0);
    for (const [index, [idleKey, idleEntry]] of idle.entries()) {
      if (idle.length - index <= MAX_IDLE_MODELS && idleBytes <= MAX_IDLE_BYTES) break;
      idleBytes -= idleEntry.estimatedBytes ?? 0;
      this.evict(idleKey, idleEntry);
    }
  }
}

export class ModelRequestError extends Error {
  readonly status: number;
  constructor(name: string, status: number) {
    super(name + " request failed (" + status + ")");
    this.status = status;
  }
}

async function loadModel(asset: CatalogueAsset, signal: AbortSignal): Promise<THREE.Group> {
  const response = await fetch(asset.url, {
    signal: combineAbortSignals([signal, AbortSignal.timeout(120_000)]),
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new ModelRequestError(asset.name, response.status);
  }
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  return (await new GLTFLoader().parseAsync(bytes, "")).scene;
}

function modelResources(roots: THREE.Object3D[]) {
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  for (const root of roots) {
    root.traverse((object) => {
      if (
        !(
          object instanceof THREE.Mesh ||
          object instanceof THREE.Line ||
          object instanceof THREE.Points
        )
      ) {
        return;
      }
      resources.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (resources.has(material)) continue;
        resources.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) resources.add(value);
        }
      }
    });
  }
  return resources;
}

// Static GLBs use image-backed colour maps. Count their RGBA8 footprint including mipmaps
// and distinct backing buffers. This controls idle retention, not total driver allocations
function estimateModelBytes(model: THREE.Group): number {
  let bytes = 0;
  const buffers = new Set<ArrayBufferLike>();
  for (const resource of modelResources([model])) {
    if (resource instanceof THREE.Texture) {
      bytes +=
        (resource.width || 0) * (resource.height || 0) * 4 * (resource.generateMipmaps ? 4 / 3 : 1);
    } else if (resource instanceof THREE.BufferGeometry) {
      for (const attribute of Object.values(resource.attributes))
        buffers.add(attribute.array.buffer);
      if (resource.index) buffers.add(resource.index.array.buffer);
    }
  }
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

export function disposeModels(...roots: THREE.Object3D[]): void {
  const images = new Set<ImageBitmap>();
  const resources = modelResources(roots);
  for (const resource of resources) {
    if (
      resource instanceof THREE.Texture &&
      typeof ImageBitmap !== "undefined" &&
      resource.image instanceof ImageBitmap
    ) {
      images.add(resource.image);
    }
    resource.dispose();
  }
  for (const image of images) {
    image.close();
  }
}
