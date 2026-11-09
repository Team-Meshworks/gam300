import * as THREE from "three";
import type { Vector3Tuple } from "../../shared/project/scene-object";
export type RoomFootprint = Readonly<{ id: string; bounds: THREE.Box3; transform?: THREE.Matrix4 }>;
// Test the room's local floor footprint so rotated rooms do not claim empty bounding-box corners.
export function roomAtPosition(
  position: Vector3Tuple,
  rooms: readonly RoomFootprint[],
): string | null {
  for (const room of rooms) {
    const point = new THREE.Vector3(...position);
    if (room.transform) point.applyMatrix4(room.transform.clone().invert());
    if (
      point.x >= room.bounds.min.x &&
      point.x <= room.bounds.max.x &&
      point.z >= room.bounds.min.z &&
      point.z <= room.bounds.max.z
    )
      return room.id;
  }
  return null;
}
