import * as THREE from "three";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { lightExhibitionScene } from "../../shared/asset-runtime/scene-lighting";
import { prepareModels } from "./model-preparation";

export type LibraryPreviewAsset = CatalogueAsset & { sceneLighting?: boolean };

export async function drawLibraryPreview(
  renderer: THREE.WebGLRenderer,
  source: THREE.Object3D,
  asset: LibraryPreviewAsset,
  signal: AbortSignal,
  previewMaterial?: THREE.Material,
) {
  const box = new THREE.Box3().setFromObject(source);
  if (box.isEmpty()) return false;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scene = new THREE.Scene();
  if (asset.sceneLighting) {
    lightExhibitionScene(scene);
    scene.background = null;
    scene.fog = null;
  } else {
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(5, 10, 7);
    scene.add(light);
  }
  const model = source.clone(true);
  if (previewMaterial)
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) node.material = previewMaterial;
    });
  scene.add(model);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, asset.sceneLighting ? 1000 : 10000);
  const distance = (Math.max(size.length(), 0.1) / 2 / Math.sin((35 * Math.PI) / 360)) * 1.05;
  const offset =
    asset.kind === "environment"
      ? new THREE.Vector3(0.7, 1.3, 1).normalize().multiplyScalar(distance)
      : new THREE.Vector3(0, size.y * 0.1, distance);
  camera.position.copy(center).add(offset);
  camera.lookAt(center);
  await prepareModels(renderer, [model], camera, scene, signal);
  signal.throwIfAborted();
  renderer.render(scene, camera);
  return true;
}
