import * as THREE from "three";

// Hidden glass covers and editor markers must not enlarge an exhibit's outline.
export function visibleModelBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  root.traverseVisible((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (node.geometry.boundingBox)
      bounds.union(node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld));
  });
  return bounds;
}
