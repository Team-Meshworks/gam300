import type { Vector3Tuple } from "./scene-object";

export type RoomFootprint = Readonly<{ halfWidth: number; halfDepth: number }>;
export type PositionedRoomFootprint = RoomFootprint & Readonly<{ position: Vector3Tuple }>;
export const ROOM_GRID_HALF_SIZE = 40;

// Footprints and the requested point are expressed in the same room-layout frame
export function snapRoomBounds(
  position: Vector3Tuple,
  moving: RoomFootprint,
  stationary: readonly PositionedRoomFootprint[],
  gridHalfSize = ROOM_GRID_HALF_SIZE,
): Vector3Tuple | null {
  const candidates: Vector3Tuple[] = stationary.flatMap((room) => [
    [room.position[0] + room.halfWidth + moving.halfWidth, room.position[1], room.position[2]],
    [room.position[0] - room.halfWidth - moving.halfWidth, room.position[1], room.position[2]],
    [room.position[0], room.position[1], room.position[2] + room.halfDepth + moving.halfDepth],
    [room.position[0], room.position[1], room.position[2] - room.halfDepth - moving.halfDepth],
  ]);
  const available = candidates.filter(
    ([x, , z]) =>
      Math.abs(x) + moving.halfWidth <= gridHalfSize + 1e-8 &&
      Math.abs(z) + moving.halfDepth <= gridHalfSize + 1e-8 &&
      stationary.every(
        (room) =>
          Math.abs(x - room.position[0]) >= room.halfWidth + moving.halfWidth - 1e-8 ||
          Math.abs(z - room.position[2]) >= room.halfDepth + moving.halfDepth - 1e-8,
      ),
  );
  available.sort(
    (a, b) =>
      Math.hypot(a[0] - position[0], a[2] - position[2]) -
      Math.hypot(b[0] - position[0], b[2] - position[2]),
  );
  return available[0] ?? null;
}
