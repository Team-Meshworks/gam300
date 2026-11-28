import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { ModelCache, type ModelLease } from "../asset-runtime/ModelCache";
import type { CatalogueAsset } from "../asset-runtime/catalogue";
import { fetchPlayerAsset } from "./player-asset";

/** One WebGL context and bounded model cache per mounted exhibition */
export function createPlayerGraphics() {
  let renderer: THREE.WebGLRenderer | undefined;
  const cache = new ModelCache();
  function resetRenderer() {
    if (!renderer) return;
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    renderer = undefined;
  }
  return {
    // Three keeps transmission targets per scene and camera, even across renderer.render calls
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1, 0.01, 2000),
    getRenderer() {
      return (renderer ??= new THREE.WebGLRenderer({ antialias: true }));
    },
    openScene(signal: AbortSignal) {
      return sceneModels(cache, signal);
    },
    resetRenderer,
    dispose() {
      cache.invalidate();
      resetRenderer();
    },
  };
}

function sceneModels(cache: ModelCache, signal: AbortSignal) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("blob:") && !url.startsWith("data:"))
      throw new Error("External exhibition resources are unsupported.");
    return url;
  });
  const loader = new GLTFLoader(manager);
  const requests = new Map<CatalogueAsset, Promise<ModelLease>>();
  const leases = new Set<ModelLease>();
  const instances: THREE.Object3D[] = [];
  let closed = false;

  async function acquire(asset: CatalogueAsset) {
    // Recheck access and integrity on every scene visit, including warm cache hits
    const response = await fetchPlayerAsset(asset.url, signal);
    if (!response.ok)
      throw new Error("An exhibition asset is unavailable. Your access may have changed.");
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !==
      asset.sha256.toLowerCase()
    )
      throw new Error("An exhibition asset could not be verified.");
    const lease = await cache.acquire(
      asset,
      signal,
      async () => (await loader.parseAsync(bytes, "")).scene,
    );
    if (closed || signal.aborted) {
      lease.release();
      throw new DOMException("Scene closed", "AbortError");
    }
    leases.add(lease);
    return lease;
  }

  return {
    async instantiate(asset: CatalogueAsset) {
      signal.throwIfAborted();
      let request = requests.get(asset);
      if (!request) {
        request = acquire(asset);
        requests.set(asset, request);
      }
      const lease = await request;
      if (closed || signal.aborted) throw new DOMException("Scene closed", "AbortError");
      // Bones and transforms belong to the instance. Geometry, materials and maps belong to the lease
      const instance = clone(lease.value.model);
      instances.push(instance);
      return instance;
    },
    dispose() {
      closed = true;
      for (const instance of instances) {
        instance.removeFromParent();
        instance.traverse((node) => {
          if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
        });
      }
      instances.length = 0;
      for (const lease of leases) lease.release();
      leases.clear();
      requests.clear();
    },
  };
}
