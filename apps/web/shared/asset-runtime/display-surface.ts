import * as THREE from "three";
import type { ContentComponent } from "../project/project-content";
import type { CatalogueAsset } from "./catalogue";

export function displaySurface(
  asset: CatalogueAsset,
  content: ContentComponent,
  model?: THREE.Object3D | THREE.Box3,
): CatalogueAsset["displaySurface"] {
  let resolved = asset.displaySurface;
  if (asset.displayRole === "physical" && content.type === "text" && !content.placement) {
    if (!model) return;
    const box = model instanceof THREE.Box3 ? model : new THREE.Box3().setFromObject(model),
      size = box.getSize(new THREE.Vector3());
    const width = Math.max(0.2, size.x * 0.9);
    resolved = {
      position: [
        (box.min.x + box.max.x) / 2,
        box.min.y + (asset.displayTop ?? size.y) / 2,
        box.max.z + 0.006,
      ],
      rotation: [0, 0, 0, 1],
      width,
      height: width * 0.6,
    };
  }
  if (content.type === "text" && content.placement)
    resolved = {
      position: content.placement.position,
      rotation: content.placement.rotation,
      width: content.placement.scale[0],
      height: content.placement.scale[1],
    };
  return resolved;
}
