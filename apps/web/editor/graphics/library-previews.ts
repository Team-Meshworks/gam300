import * as THREE from "three";
import { ModelCache } from "../../shared/asset-runtime/ModelCache";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";

/** Generate local previews of accessible models without persisting their bytes */
export function generateLibraryPreviews(
  assets: readonly CatalogueAsset[],
  onPreview: (id: string, image: string) => void,
): () => void {
  const controller = new AbortController();
  const cache = new ModelCache();
  void (async () => {
    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(1);
      renderer.setSize(320, 320, false);
      renderer.setClearColor(0, 0);
      for (const asset of assets) {
        if (controller.signal.aborted) break;
        if (asset.thumbnail || (asset.kind !== "model" && asset.kind !== "environment")) continue;
        try {
          const lease = await cache.acquire(asset, controller.signal);
          try {
            if (controller.signal.aborted) break;
            const box = new THREE.Box3().setFromObject(lease.value.model);
            if (box.isEmpty()) continue;
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            const scene = new THREE.Scene();
            scene.add(new THREE.AmbientLight(0xffffff, 1.5));
            const light = new THREE.DirectionalLight(0xffffff, 2);
            light.position.set(5, 10, 7);
            scene.add(light, lease.value.model.clone(true));
            const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
            const distance =
              (Math.max(size.length(), 0.1) / 2 / Math.sin((35 * Math.PI) / 360)) * 1.05;
            const offset =
              asset.kind === "environment"
                ? new THREE.Vector3(0.7, 1.3, 1).normalize().multiplyScalar(distance)
                : new THREE.Vector3(0, size.y * 0.1, distance);
            camera.position.copy(center).add(offset);
            camera.lookAt(center);
            renderer.render(scene, camera);
            onPreview(asset.id, renderer.domElement.toDataURL("image/png"));
          } finally {
            lease.release();
          }
        } catch {
          // A missing or invalid model leaves its card usable with the existing fallback
        }
      }
    } catch {
      // WebGL may be unavailable; retain the existing image fallback
    } finally {
      cache.invalidate();
      renderer?.dispose();
    }
  })();
  return () => controller.abort();
}
