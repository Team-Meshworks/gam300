import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const directions: Record<string, THREE.Vector3> = {
  Wall_Back: new THREE.Vector3(0, 0, -1),
  Wall_Front: new THREE.Vector3(0, 0, 1),
  Wall_Left: new THREE.Vector3(-1, 0, 0),
  Wall_Right: new THREE.Vector3(1, 0, 0),
};

// Replace only the centre opening; keep two jambs and a lintel within the original wall bounds
function doorway(source: THREE.BufferGeometry, alongX: boolean) {
  source.computeBoundingBox();
  const box = source.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const length = alongX ? size.x : size.z;
  const thickness = alongX ? size.z : size.x;
  const width = 2,
    height = 2.4,
    sideWidth = (length - width) / 2;
  const pieces = [
    { width: sideWidth, height: size.y, offset: -(length + width) / 4, y: center.y },
    { width: sideWidth, height: size.y, offset: (length + width) / 4, y: center.y },
    { width, height: size.y - height, offset: 0, y: box.min.y + height + (size.y - height) / 2 },
  ].map((piece) => {
    const geometry = new THREE.BoxGeometry(
      alongX ? piece.width : thickness,
      piece.height,
      alongX ? thickness : piece.width,
    );
    geometry.translate(
      center.x + (alongX ? piece.offset : 0),
      piece.y,
      center.z + (alongX ? 0 : piece.offset),
    );
    return geometry;
  });
  const geometry = mergeGeometries(pieces)!;
  for (const piece of pieces) piece.dispose();
  return geometry;
}

// Only the approved Starter room's named walls have known connection geometry
// Cached models remain untouched; each viewport owns its cut wall geometry
export function createRoomEntrances() {
  const changed = new Map<
    THREE.Mesh,
    { original: THREE.BufferGeometry; opening: THREE.BufferGeometry }
  >();
  function restore(mesh: THREE.Mesh) {
    const entry = changed.get(mesh)!;
    mesh.geometry = entry.original;
    entry.opening.dispose();
    changed.delete(mesh);
  }
  return {
    sync(rooms: readonly THREE.Object3D[]) {
      const walls: {
        mesh: THREE.Mesh;
        edge: THREE.Vector3;
        normal: THREE.Vector3;
        alongX: boolean;
      }[] = [];
      for (const room of rooms) {
        room.updateWorldMatrix(true, true);
        const scale = room.getWorldScale(new THREE.Vector3());
        const up = new THREE.Vector3(0, 1, 0).transformDirection(room.matrixWorld);
        // Imported scaled/tilted rooms retain their walls rather than mismatched openings
        if (scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-5 || up.y < 0.99999) continue;
        room.traverse((node) => {
          const direction = directions[node.name];
          if (!(node instanceof THREE.Mesh) || !direction) return;
          const original = changed.get(node)?.original ?? node.geometry;
          original.computeBoundingBox();
          const normal = direction.clone().transformDirection(room.matrixWorld);
          const edge = original
            .boundingBox!.getCenter(new THREE.Vector3())
            .applyMatrix4(node.matrixWorld);
          edge.addScaledVector(normal, 0.1);
          walls.push({ mesh: node, edge, normal, alongX: direction.z !== 0 });
        });
      }
      // Opposing coincident wall faces form a connection; exterior and offset walls stay closed
      const open = new Set<THREE.Mesh>();
      for (let a = 0; a < walls.length; a++) {
        const first = walls[a]!;
        for (let b = a + 1; b < walls.length; b++) {
          const second = walls[b]!;
          if (
            first.normal.dot(second.normal) > -0.99999 ||
            first.edge.distanceTo(second.edge) > 0.001
          )
            continue;
          open.add(first.mesh);
          open.add(second.mesh);
        }
      }
      // Restore separated rooms before cutting new pairs, releasing every viewport-owned geometry
      for (const mesh of changed.keys()) if (!open.has(mesh)) restore(mesh);
      for (const wall of walls) {
        if (!open.has(wall.mesh) || changed.has(wall.mesh)) continue;
        const original = wall.mesh.geometry;
        const opening = doorway(original, wall.alongX);
        wall.mesh.geometry = opening;
        changed.set(wall.mesh, { original, opening });
      }
    },
    dispose() {
      for (const mesh of changed.keys()) restore(mesh);
    },
  };
}
