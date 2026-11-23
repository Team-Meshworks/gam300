import * as THREE from "three";
export { visibleModelBounds } from "../../shared/asset-runtime/ModelCache";

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
