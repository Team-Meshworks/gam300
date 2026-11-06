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

// Raycaster includes hidden geometry; picking must use the same ancestor visibility as rendering
export function visibleRaycastHit(hit: THREE.Intersection): boolean {
  for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

export type ExhibitHit = { id: string; distance: number; glass: boolean; parentId: string | null };

// A filled case remains visible, but its transparent cover must not hide its own exhibit from picking
export function nearestExhibitHit(hits: readonly ExhibitHit[]): ExhibitHit | undefined {
  const ordered = [...hits].sort((a, b) => a.distance - b.distance);
  const first = ordered[0];
  if (!first?.glass) return first;
  return ordered.find((hit) => hit.parentId === first.id) ?? first;
}
