import type { ProjectScene } from "./project-types";
import type { SceneObject, Vector3Tuple } from "./scene-object";
import { ROOM_GRID_HALF_SIZE, snapRoomBounds, type RoomFootprint } from "./room-bounds";

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
  environmentAssetId?: string | null,
  environmentTransform?: SceneObject["transform"],
  isRoomModel: RoomModelPredicate = isPackagedRoomModel,
  roomFootprint: (assetId: string) => RoomFootprint = () => ({ halfWidth: 5, halfDepth: 5 }),
  movingAssetId = "test-room-module-v1",
  movingFootprint?: RoomFootprint,
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
  const rooms = objects.filter((object) => isRoomModel(object.assetId));
  if (environmentAssetId)
    rooms.unshift({
      id: "environment",
      name: "Room",
      assetId: environmentAssetId,
      transform: environmentTransform ?? {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
  const footprints = rooms.map(({ transform, assetId }) => {
    const [u, v, a, b] = transform.rotation;
    const [x, y, z, w] = [c * u - s * a, c * v - s * b, c * a + s * u, c * b + s * v];
    const origin = toFrame(transform.position);
    const [sx, sy, sz] = transform.scale;
    const { halfWidth, halfDepth } = roomFootprint(assetId);
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
      halfX:
        Math.abs(xx * sx * halfWidth) + Math.abs(xy * sy * 1.6) + Math.abs(xz * sz * halfDepth),
      halfZ:
        Math.abs(zx * sx * halfWidth) + Math.abs(zy * sy * 1.6) + Math.abs(zz * sz * halfDepth),
    };
  });
  if (footprints.length === 0) {
    return position;
  }

  const closest = snapRoomBounds(
    requested,
    movingFootprint ?? roomFootprint(movingAssetId),
    footprints.map((room) => ({
      position: [room.x, room.y, room.z] as const,
      halfWidth: room.halfX,
      halfDepth: room.halfZ,
    })),
    ROOM_GRID_HALF_SIZE,
  );
  return closest
    ? [
        cosine * closest[0] + sine * closest[2],
        closest[1],
        -sine * closest[0] + cosine * closest[2],
      ]
    : null;
}

// The entire room footprint must fit inside the visible placement grid
export function roomFitsGrid(
  position: Vector3Tuple,
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
  footprint: RoomFootprint = { halfWidth: 5, halfDepth: 5 },
): boolean {
  const [x, y, z, w] = rotation;
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
  const halfX =
    footprint.halfWidth * Math.abs(Math.cos(yaw)) + footprint.halfDepth * Math.abs(Math.sin(yaw));
  const halfZ =
    footprint.halfWidth * Math.abs(Math.sin(yaw)) + footprint.halfDepth * Math.abs(Math.cos(yaw));
  return (
    position.every(Number.isFinite) &&
    Math.abs(position[0]) + halfX <= ROOM_GRID_HALF_SIZE + 1e-8 &&
    Math.abs(position[2]) + halfZ <= ROOM_GRID_HALF_SIZE + 1e-8
  );
}
