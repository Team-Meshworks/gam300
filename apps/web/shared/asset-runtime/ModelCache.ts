import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CatalogueAsset } from "./catalogue";

const IDLE_MS = 30_000;
// ponytail: three idle models fit the M1 catalogue; add a byte budget for a larger library
const MAX_IDLE_MODELS = 3;

type LoadedModel = { readonly model: THREE.Group; thumbnail: string | undefined };
type Entry = {
  assetId: string;
  controller: AbortController;
  promise: Promise<LoadedModel>;
  value: LoadedModel | undefined;
  users: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type ModelLease = { readonly value: LoadedModel; release(): void };

/** Owns immutable model resources; callers clone nodes and release each acquired lease */
export class ModelCache {
  private readonly entries = new Map<string, Entry>();

  acquire(asset: CatalogueAsset, signal: AbortSignal): Promise<ModelLease> {
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
        promise: loadModel(asset, controller.signal)
          .then((value) => {
            // Parsing cannot be aborted; reclaim its late result after the last waiter cancels
            if (controller.signal.aborted) {
              disposeModels(value.model);
              controller.signal.throwIfAborted();
            }
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
    const idle = [...this.entries].filter(([, candidate]) => candidate.users === 0);
    for (const [idleKey, idleEntry] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_MODELS))) {
      this.evict(idleKey, idleEntry);
    }
  }
}

async function loadModel(asset: CatalogueAsset, signal: AbortSignal): Promise<LoadedModel> {
  const response = await fetch(asset.url, { signal });
  if (!response.ok) {
    throw new Error(asset.name + " request failed (" + response.status + ")");
  }
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  const { scene } = await new GLTFLoader().parseAsync(bytes, "");
  if (asset.placement === "bottom-center") {
    const box = new THREE.Box3().setFromObject(scene);
    const center = box.getCenter(new THREE.Vector3());
    scene.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  }
  return { model: scene, thumbnail: undefined };
}

export function disposeModels(...roots: THREE.Object3D[]): void {
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  const images = new Set<ImageBitmap>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) {
        return;
      }
      resources.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        resources.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) {
            resources.add(value);
            const image: unknown = value.source.data;
            if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
              images.add(image);
            }
          }
        }
      }
    });
  }
  for (const resource of resources) {
    resource.dispose();
  }
  for (const image of images) {
    image.close();
  }
}
