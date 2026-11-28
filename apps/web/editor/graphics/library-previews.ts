import * as THREE from "three";
import { ModelCache } from "../../shared/asset-runtime/ModelCache";
import { drawLibraryPreview, type LibraryPreviewAsset } from "./library-preview-frame";
import type { PreviewResult } from "./library-preview.worker";
export { editorModelCache } from "./editor-model-cache";

/** Generate local previews of accessible models without persisting their bytes */
export function generateLibraryPreviews(
  assets: readonly LibraryPreviewAsset[],
  onPreview: (id: string, image: string) => void,
  fitFrame = false,
  sharedCache?: ModelCache,
): () => void {
  const pending = assets.filter(
    (asset) => !asset.thumbnail && (asset.kind === "model" || asset.kind === "environment"),
  );
  if (pending.length === 0) return () => {};
  if (fitFrame || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined")
    return generateOnMain(pending, onPreview, fitFrame, sharedCache);

  const remaining = new Map(pending.map((asset) => [asset.id, asset]));
  let worker: Worker | undefined;
  let stopFallback: (() => void) | undefined;
  function finishWorker() {
    worker?.terminate();
    worker = undefined;
    // A worker can finish normally after skipping an individual model.
    if (remaining.size > 0)
      stopFallback = generateOnMain([...remaining.values()], onPreview, fitFrame, sharedCache);
  }
  try {
    worker = new Worker(new URL("./library-preview.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }: MessageEvent<PreviewResult>) => {
      if (!worker) return;
      if (data.type !== "preview") return finishWorker();
      remaining.delete(data.id);
      onPreview(data.id, data.image);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (worker) finishWorker();
    };
    worker.postMessage(
      pending.map((asset) => ({ ...asset, url: new URL(asset.url, document.baseURI).href })),
    );
  } catch {
    finishWorker();
  }
  return () => {
    worker?.terminate();
    worker = undefined;
    stopFallback?.();
  };
}

function generateOnMain(
  assets: readonly LibraryPreviewAsset[],
  onPreview: (id: string, image: string) => void,
  fitFrame: boolean,
  sharedCache?: ModelCache,
): () => void {
  const controller = new AbortController();
  const cache = sharedCache ?? new ModelCache();
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
        try {
          const lease = await cache.acquire(asset, controller.signal);
          try {
            if (controller.signal.aborted) break;
            if (
              !(await drawLibraryPreview(
                renderer,
                lease.value.model,
                asset,
                controller.signal,
                previewMaterial,
              ))
            )
              continue;
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
      if (!sharedCache) cache.invalidate();
      renderer?.dispose();
      renderer?.forceContextLoss();
      previewMaterial?.dispose();
    }
  })();
  return () => controller.abort();
}
