import type { SceneObject, Vector3Tuple } from "./scene-object";

export function snapRoomPlacement(
  position: Vector3Tuple,
  objects: readonly SceneObject[],
  environmentAssetId?: string,
): Vector3Tuple | null {
  // The approved test-room GLB spans -5 to 5 on floor axes and -0.2 to 3 in height
  // Keep this asset-specific until production rooms supply approved connection points
  const rooms = objects.filter((object) => object.assetId === "test-room-module-v1");
  const footprints = rooms.map(({ transform }) => {
    const [x, y, z, w] = transform.rotation;
    const [sx, sy, sz] = transform.scale;
    // Project the transformed room bounds onto the floor, including tilted rooms
    // Conservative bounds prevent a new room from cutting through existing geometry
    const xx = 1 - 2 * (y * y + z * z);
    const xy = 2 * (x * y - z * w);
    const xz = 2 * (x * z + y * w);
    const zx = 2 * (x * z - y * w);
    const zy = 2 * (y * z + x * w);
    const zz = 1 - 2 * (x * x + y * y);
    return {
      x: transform.position[0] + xy * 1.4 * sy,
      z: transform.position[2] + zy * 1.4 * sy,
      halfX: Math.abs(xx * sx * 5) + Math.abs(xy * sy * 1.6) + Math.abs(xz * sz * 5),
      halfZ: Math.abs(zx * sx * 5) + Math.abs(zy * sy * 1.6) + Math.abs(zz * sz * 5),
    };
  });
  // The initial environment has no object transform and always occupies the origin
  if (environmentAssetId === "test-room-v1") {
    footprints.unshift({ x: 0, z: 0, halfX: 5, halfZ: 5 });
  }
  if (footprints.length === 0) {
    return position;
  }

  // Compare the four adjoining positions on every room, skipping occupied sides
  // Pointer proximity chooses the side; stable ordering resolves exact ties
  const candidates: Vector3Tuple[] = footprints.flatMap((room) => [
    [room.x + room.halfX + 5, 0, room.z],
    [room.x - room.halfX - 5, 0, room.z],
    [room.x, 0, room.z + room.halfZ + 5],
    [room.x, 0, room.z - room.halfZ - 5],
  ]);
  const available = candidates.filter(
    ([x, , z]) =>
      Math.abs(x) <= 10_000 &&
      Math.abs(z) <= 10_000 &&
      footprints.every(
        (room) =>
          Math.abs(x - room.x) >= room.halfX + 5 - 1e-8 ||
          Math.abs(z - room.z) >= room.halfZ + 5 - 1e-8,
      ),
  );
  available.sort(
    (a, b) =>
      Math.hypot(a[0] - position[0], a[2] - position[2]) -
      Math.hypot(b[0] - position[0], b[2] - position[2]),
  );
  return available[0] ?? null;
}
