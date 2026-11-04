import * as THREE from "three";
import type { Vector3Tuple } from "../../shared/project/scene-object";

// Preview borrows cached geometry and textures; only its translucent material copies are owned here.
export function createPlacementPreview(
  scene: THREE.Scene,
  models: ReadonlyMap<string, THREE.Object3D>,
) {
  let ghost: THREE.Object3D | undefined;
  let asset: string | undefined;
  const materials: THREE.Material[] = [];
  function clear() {
    if (ghost) scene.remove(ghost);
    for (const material of materials) material.dispose();
    materials.length = 0;
    ghost = undefined;
    asset = undefined;
  }
  return {
    clear,
    show(id: string | undefined, position: Vector3Tuple | undefined, scale = 1) {
      if (id !== asset) {
        clear();
        const model = id === undefined ? undefined : models.get(id);
        if (!model) return;
        asset = id;
        ghost = new THREE.Group();
        ghost.add(model.clone(true));
        ghost.name = "placement-preview";
        ghost.traverse((node) => {
          if (!(node instanceof THREE.Mesh || node instanceof THREE.Sprite)) return;
          const copy = (source: THREE.Material) => {
            const material = source.clone();
            material.transparent = true;
            material.opacity = 0.4;
            material.depthWrite = false;
            if ("color" in material && material.color instanceof THREE.Color)
              material.color.set("#999999");
            materials.push(material);
            return material;
          };
          node.material = Array.isArray(node.material)
            ? node.material.map(copy)
            : copy(node.material);
        });
        scene.add(ghost);
      }
      if (ghost) {
        ghost.visible = position !== undefined;
        ghost.scale.setScalar(scale);
        if (position) ghost.position.fromArray(position);
      }
    },
  };
}
