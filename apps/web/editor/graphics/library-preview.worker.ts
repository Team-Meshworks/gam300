import * as THREE from "three";
import { ModelCache } from "../../shared/asset-runtime/ModelCache";
import { drawLibraryPreview, type LibraryPreviewAsset } from "./library-preview-frame";

export type PreviewResult =
  | { type: "preview"; id: string; image: string }
  | { type: "unavailable" }
  | { type: "done" };

const send = (result: PreviewResult) => self.postMessage(result);

function pngDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

self.onmessage = async ({ data: assets }: MessageEvent<LibraryPreviewAsset[]>) => {
  let renderer: THREE.WebGLRenderer | undefined;
  const cache = new ModelCache();
  const signal = new AbortController().signal;
  try {
    if (typeof createImageBitmap !== "function") return send({ type: "unavailable" });
    const canvas = new OffscreenCanvas(320, 320);
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(320, 320, false);
    renderer.setClearColor(0, 0);
    for (const asset of assets) {
      if (asset.thumbnail || (asset.kind !== "model" && asset.kind !== "environment")) continue;
      const lease = await cache.acquire(asset, signal).catch(() => undefined);
      if (!lease) continue;
      try {
        if (await drawLibraryPreview(renderer, lease.value.model, asset, signal)) {
          const image = await pngDataUrl(await canvas.convertToBlob({ type: "image/png" }));
          send({ type: "preview", id: asset.id, image });
        }
      } finally {
        lease.release();
        cache.invalidate(asset.id);
      }
    }
  } catch {
    send({ type: "unavailable" });
    return;
  } finally {
    cache.invalidate();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
  send({ type: "done" });
};
