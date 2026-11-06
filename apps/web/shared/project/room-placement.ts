import type { ProjectScene } from "./project-types";
import type { SceneObject, Vector3Tuple } from "./scene-object";

export type RoomModelPredicate = (assetId: string) => boolean;
export const isPackagedRoomModel: RoomModelPredicate = (id) => id === "test-room-module-v1";

// Keep the remaining room as the layout reference when the initial environment was deleted
export function roomLayoutTransform(
  objects: readonly SceneObject[],
  scene: ProjectScene | null | undefined,
  isRoomModel: RoomModelPredicate = isPackagedRoomModel,
) {
  return scene?.environmentVisible === false
    ? objects.find((object) => isRoomModel(object.assetId))?.transform
    : scene?.environmentTransform;
}

export function snapRoomPlacement(
  position: Vector3Tuple,
  objects: readonly SceneObject[],
  environmentAssetId?: string,
  environmentTransform?: SceneObject["transform"],
  isRoomModel: RoomModelPredicate = isPackagedRoomModel,
): Vector3Tuple | null {
  // Compare room footprints in the layout frame so rotated layouts keep their adjoining sides
  const frame =
    environmentTransform ?? objects.find((object) => isRoomModel(object.assetId))?.transform;
  const [qx, qy, qz, qw] = frame?.rotation ?? [0, 0, 0, 1];
  const angle = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz));
  const cosine = Math.cos(angle),
    sine = Math.sin(angle),
    c = Math.cos(angle / 2),
    s = Math.sin(angle / 2);
  const toFrame = ([x, y, z]: Vector3Tuple): Vector3Tuple => [
    cosine * x - sine * z,
    y,
    sine * x + cosine * z,
  ];
  const requested = toFrame(position);
  // Approved Starter room geometry spans -5 to 5 on floor axes and -0.2 to 3 in height
  // Keep this asset-specific until production rooms supply approved connection points
  const rooms = objects.filter((object) => isRoomModel(object.assetId));
  if (environmentAssetId === "test-room-v1")
    rooms.unshift({
      id: "environment",
      name: "Room",
      assetId: "test-room-module-v1",
      transform: environmentTransform ?? {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
  const footprints = rooms.map(({ transform }) => {
    const [u, v, a, b] = transform.rotation;
    const [x, y, z, w] = [c * u - s * a, c * v - s * b, c * a + s * u, c * b + s * v];
    const origin = toFrame(transform.position);
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
      y: transform.position[1],
      x: origin[0] + xy * 1.4 * sy,
      z: origin[2] + zy * 1.4 * sy,
      halfX: Math.abs(xx * sx * 5) + Math.abs(xy * sy * 1.6) + Math.abs(xz * sz * 5),
      halfZ: Math.abs(zx * sx * 5) + Math.abs(zy * sy * 1.6) + Math.abs(zz * sz * 5),
    };
  });
  if (footprints.length === 0) {
    return position;
  }

  // Compare the four adjoining positions on every room, skipping occupied sides
  // Pointer proximity chooses the side; stable ordering resolves exact ties
  const candidates: Vector3Tuple[] = footprints.flatMap((room) => [
    [room.x + room.halfX + 5, room.y, room.z],
    [room.x - room.halfX - 5, room.y, room.z],
    [room.x, room.y, room.z + room.halfZ + 5],
    [room.x, room.y, room.z - room.halfZ - 5],
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
      Math.hypot(a[0] - requested[0], a[2] - requested[2]) -
      Math.hypot(b[0] - requested[0], b[2] - requested[2]),
  );
  const closest = available[0];
  return closest
    ? [
        cosine * closest[0] + sine * closest[2],
        closest[1],
        -sine * closest[0] + cosine * closest[2],
      ]
    : null;
}

// GridHelper spans forty metres; the entire room footprint must fit inside it
export function roomFitsGrid(
  position: Vector3Tuple,
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
): boolean {
  const [x, y, z, w] = rotation;
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
  const half = 5 * (Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw)));
  return (
    position.every(Number.isFinite) &&
    Math.abs(position[0]) + half <= 20 + 1e-8 &&
    Math.abs(position[2]) + half <= 20 + 1e-8
  );
}
