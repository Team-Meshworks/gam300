import * as THREE from "three";

/** Prepare this renderer's programs and uploads before exposing a model to placement */
export async function prepareModels(
  renderer: Pick<THREE.WebGLRenderer, "compileAsync" | "initTexture">,
  models: readonly THREE.Object3D[],
  camera: THREE.Camera,
  scene: THREE.Scene,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const textures = new Set<THREE.Texture>();
  for (const model of models) {
    model.traverse((node) => {
      if (
        !(node instanceof THREE.Mesh) &&
        !(node instanceof THREE.Sprite) &&
        !(node instanceof THREE.Line) &&
        !(node instanceof THREE.Points)
      )
        return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
  }
  await Promise.all(models.map((model) => renderer.compileAsync(model, camera, scene)));
  signal.throwIfAborted();
  for (const texture of textures) {
    // Uploading all maps in the first visible render blocks that entire frame
    await nextFrame(signal);
    signal.throwIfAborted();
    renderer.initTexture(texture);
  }
}

function nextFrame(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    const abort = () => {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
