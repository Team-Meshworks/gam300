import * as THREE from "three";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { Transform } from "../../shared/project/project-types";
import { visibleModelBounds } from "./visible-model-bounds";
import type { PlacementBody } from "./placement-constraints";

export function placementBody(
  id: string,
  transform: Transform,
  model: THREE.Object3D,
  asset: CatalogueAsset,
): PlacementBody {
  const bounds = visibleModelBounds(model);
  const body: PlacementBody = { id, transform, bounds };
  if (asset.kind === "environment" || asset.id === "test-room-module-v1") {
    const interior = bounds.clone();
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const face = visibleModelBounds(node);
      if (node.name === "floor") interior.min.y = face.max.y;
      if (node.name === "Wall_Left") interior.min.x = face.max.x;
      if (node.name === "Wall_Right") interior.max.x = face.min.x;
      if (node.name === "Wall_Back") interior.min.z = face.max.z;
      if (node.name === "Wall_Front") interior.max.z = face.min.z;
    });
    body.room = interior;
  }
  if (asset.displayRole === "physical") {
    const glass = new THREE.Box3();
    const shelves: THREE.Box3[] = [];
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      if (materials.every((material) => material.transparent && material.opacity < 0.9))
        glass.union(visibleModelBounds(node));
      else {
        const solid = visibleModelBounds(node);
        const size = solid.getSize(new THREE.Vector3());
        if (size.y < Math.min(size.x, size.z) * 0.2) shelves.push(solid);
      }
    });
    const top = asset.displayTop ?? bounds.max.y;
    body.display = { top };
    if (!glass.isEmpty()) {
      // Curated cases have 2cm side panes and roof sections up to 4.46cm thick
      glass.min.x += 0.02;
      glass.min.z += 0.02;
      glass.max.x -= 0.02;
      glass.max.z -= 0.02;
      glass.min.y = top;
      glass.max.y -= 0.05;
      for (const shelf of shelves) {
        if (
          shelf.min.y > top + 1e-5 &&
          shelf.min.x < glass.max.x &&
          shelf.max.x > glass.min.x &&
          shelf.min.z < glass.max.z &&
          shelf.max.z > glass.min.z
        )
          glass.max.y = Math.min(glass.max.y, shelf.min.y - 0.001);
      }
      body.display.interior = glass;
    }
  }
  return body;
}
