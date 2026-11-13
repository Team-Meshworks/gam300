import * as THREE from "three";
import { ModelCache } from "../../shared/asset-runtime/ModelCache";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";

/** Generate local previews of accessible models without persisting their bytes */
export function generateLibraryPreviews(
  assets: readonly CatalogueAsset[],
  onPreview: (id: string, image: string) => void,
  fitFrame = false,
): () => void {
  const controller = new AbortController();
  const cache = new ModelCache();
  void (async () => {
    let renderer: THREE.WebGLRenderer | undefined;
    // Room-choice previews share a light finish; ordinary library previews retain authored materials.
    const previewMaterial = fitFrame
      ? new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 1, metalness: 0 })
      : undefined;
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
            const model = lease.value.model.clone(true);
            if (previewMaterial)
              model.traverse((node) => {
                if (node instanceof THREE.Mesh) node.material = previewMaterial;
              });
            scene.add(light, model);
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
            if (!fitFrame) onPreview(asset.id, renderer.domElement.toDataURL("image/png"));
            else {
              // Fit visible pixels, not hidden geometry, so every room has the same centred frame.
              const frame = document.createElement("canvas");
              frame.width = frame.height = 320;
              const context = frame.getContext("2d")!;
              context.drawImage(renderer.domElement, 0, 0);
              const pixels = context.getImageData(0, 0, 320, 320).data;
              let left = 320,
                top = 320,
                right = -1,
                bottom = -1;
              for (let y = 0; y < 320; y++)
                for (let x = 0; x < 320; x++) {
                  if (pixels[(y * 320 + x) * 4 + 3]! > 8) {
                    left = Math.min(left, x);
                    right = Math.max(right, x);
                    top = Math.min(top, y);
                    bottom = Math.max(bottom, y);
                  }
                }
              if (right >= left && bottom >= top) {
                const width = right - left + 1,
                  height = bottom - top + 1;
                const scale = 288 / Math.max(width, height);
                context.clearRect(0, 0, 320, 320);
                context.drawImage(
                  renderer.domElement,
                  left,
                  top,
                  width,
                  height,
                  (320 - width * scale) / 2,
                  (320 - height * scale) / 2,
                  width * scale,
                  height * scale,
                );
              }
              onPreview(asset.id, frame.toDataURL("image/png"));
            }
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
      previewMaterial?.dispose();
    }
  })();
  return () => controller.abort();
}
