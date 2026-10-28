import type { ProjectObject, Vector3Tuple } from "./project-types";

type RoomAsset = {
  id: string;
  room?: { width: number; depth: number; environmentAssetId?: string };
};
type Footprint = { x: number; z: number; halfX: number; halfZ: number };
const SNAP_DISTANCE = 1.25;
const EPSILON = 1e-6;

// Both the drop preview and document commands use the same floor/edge calculation
export function placeRoom(
  assetId: string,
  requested: Vector3Tuple | undefined,
  assets: readonly RoomAsset[],
  objects: readonly ProjectObject[],
  scene: { environmentAssetId: string | null } | null | undefined,
  excludeId?: string,
): { position: Vector3Tuple; valid: boolean; snapped: "room" | "grid" } {
  const room = assets.find((a) => a.id === assetId)?.room;
  const source = requested ?? [0, 0, 0];
  const fallback = {
    position: [Math.round(source[0]), 0, Math.round(source[2])] as Vector3Tuple,
    valid: false,
    snapped: "grid" as const,
  };
  if (!room || !source.every(Number.isFinite) || room.width <= 0 || room.depth <= 0)
    return fallback;
  const halfX = room.width / 2,
    halfZ = room.depth / 2;
  const occupied: Footprint[] = [];
  const base = assets.find((a) => a.id === scene?.environmentAssetId)?.room;
  if (base) occupied.push({ x: 0, z: 0, halfX: base.width / 2, halfZ: base.depth / 2 });
  for (const object of objects) {
    if (object.id === excludeId) continue;
    const size = assets.find((a) => a.id === object.assetId)?.room;
    if (!size) continue;
    const [qx, qy, qz, qw] = object.transform.rotation;
    const w = (size.width * object.transform.scale[0]) / 2,
      d = (size.depth * object.transform.scale[2]) / 2;
    occupied.push({
      x: object.transform.position[0],
      z: object.transform.position[2],
      halfX: Math.abs(1 - 2 * (qy * qy + qz * qz)) * w + Math.abs(2 * (qx * qz + qw * qy)) * d,
      halfZ: Math.abs(2 * (qx * qz - qw * qy)) * w + Math.abs(1 - 2 * (qx * qx + qy * qy)) * d,
    });
  }
  const free = (x: number, z: number) =>
    Math.abs(x) <= 10_000 &&
    Math.abs(z) <= 10_000 &&
    occupied.every(
      (other) =>
        Math.abs(x - other.x) >= halfX + other.halfX - EPSILON ||
        Math.abs(z - other.z) >= halfZ + other.halfZ - EPSILON,
    );
  const candidates: { x: number; z: number }[] = [];
  const aligned = (value: number, center: number, half: number, otherHalf: number) => {
    const options = [center, center - otherHalf + half, center + otherHalf - half];
    const nearest = options.sort((a, b) => Math.abs(value - a) - Math.abs(value - b))[0]!;
    return Math.abs(nearest - value) <= SNAP_DISTANCE ? nearest : Math.round(value);
  };
  for (const other of occupied) {
    for (const direction of [1, -1]) {
      const x = other.x + direction * (other.halfX + halfX);
      const z = requested ? aligned(source[2], other.z, halfZ, other.halfZ) : other.z;
      if (
        (!requested || Math.abs(x - source[0]) <= SNAP_DISTANCE) &&
        Math.abs(z - other.z) < halfZ + other.halfZ - EPSILON &&
        free(x, z)
      )
        candidates.push({ x, z });
      const sideZ = other.z + direction * (other.halfZ + halfZ);
      const sideX = requested ? aligned(source[0], other.x, halfX, other.halfX) : other.x;
      if (
        (!requested || Math.abs(sideZ - source[2]) <= SNAP_DISTANCE) &&
        Math.abs(sideX - other.x) < halfX + other.halfX - EPSILON &&
        free(sideX, sideZ)
      )
        candidates.push({ x: sideX, z: sideZ });
    }
  }
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - source[0], a.z - source[2]) - Math.hypot(b.x - source[0], b.z - source[2]),
  );
  const candidate = candidates[0];
  if (candidate) return { position: [candidate.x, 0, candidate.z], valid: true, snapped: "room" };
  return { ...fallback, valid: free(fallback.position[0], fallback.position[2]) };
}
