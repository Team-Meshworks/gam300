import * as THREE from "three";
import type { Transform } from "../../shared/project/project-types";

export type PlacementBody = {
  id: string;
  transform: Transform;
  previous?: Transform;
  bounds: THREE.Box3;
  room?: THREE.Box3;
  display?: { top: number; interior?: THREE.Box3 };
};
const EPSILON = 1e-5;
export function placementMatrix(transform: Transform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion(...transform.rotation),
    new THREE.Vector3(...transform.scale),
  );
}
// Transform the original corners directly, avoiding inflated world AABBs in rotated rooms
export function relativePlacementBounds(
  bounds: THREE.Box3,
  transform: Transform,
  reference: Transform,
): THREE.Box3 {
  return bounds
    .clone()
    .applyMatrix4(placementMatrix(reference).invert().multiply(placementMatrix(transform)));
}
function shiftInFrame(transform: Transform, offset: THREE.Vector3, frame: Transform): Transform {
  const world = offset
    .multiply(new THREE.Vector3(...frame.scale))
    .applyQuaternion(new THREE.Quaternion(...frame.rotation));
  return { ...transform, position: new THREE.Vector3(...transform.position).add(world).toArray() };
}
function fits(size: THREE.Vector3, space: THREE.Vector3): boolean {
  return size.x <= space.x + EPSILON && size.y <= space.y + EPSILON && size.z <= space.z + EPSILON;
}
function insideFootprint(point: THREE.Vector3, box: THREE.Box3): boolean {
  return (
    point.x >= box.min.x - EPSILON &&
    point.x <= box.max.x + EPSILON &&
    point.z >= box.min.z - EPSILON &&
    point.z <= box.max.z + EPSILON
  );
}
function crossesSolid(
  body: PlacementBody,
  proposed: Transform,
  stand: PlacementBody,
  solid: THREE.Box3,
): boolean {
  const before = relativePlacementBounds(
    body.bounds,
    body.previous ?? body.transform,
    stand.transform,
  );
  const after = relativePlacementBounds(body.bounds, proposed, stand.transform);
  const start = before.getCenter(new THREE.Vector3());
  const end = after.getCenter(new THREE.Vector3());
  const padding = before
    .getSize(new THREE.Vector3())
    .max(after.getSize(new THREE.Vector3()))
    .multiplyScalar(0.5);
  const expanded = solid.clone().expandByVector(padding).expandByScalar(-EPSILON);
  if (expanded.containsPoint(start)) return false;
  const distance = start.distanceTo(end);
  if (distance < EPSILON) return false;
  const hit = new THREE.Ray(start, end.sub(start).normalize()).intersectBox(
    expanded,
    new THREE.Vector3(),
  );
  return hit !== null && start.distanceTo(hit) < distance - EPSILON;
}
function contain(
  body: PlacementBody,
  proposed: Transform,
  room: PlacementBody,
): Transform | undefined {
  const space = room.room!;
  const box = relativePlacementBounds(body.bounds, proposed, room.transform);
  if (!fits(box.getSize(new THREE.Vector3()), space.getSize(new THREE.Vector3()))) return;
  const offset = new THREE.Vector3();
  for (const axis of ["x", "y", "z"] as const)
    offset[axis] =
      box.min[axis] < space.min[axis]
        ? space.min[axis] - box.min[axis]
        : box.max[axis] > space.max[axis]
          ? space.max[axis] - box.max[axis]
          : 0;
  return offset.lengthSq() < EPSILON * EPSILON
    ? proposed
    : shiftInFrame(proposed, offset, room.transform);
}
export function resolveObjectPlacement(
  body: PlacementBody,
  proposed: Transform,
  bodies: readonly PlacementBody[],
  phase: "drag" | "release",
): Transform | undefined {
  if (body.room) return proposed;
  if (
    ![...proposed.position, ...proposed.rotation, ...proposed.scale].every(Number.isFinite) ||
    proposed.scale.some((value) => value <= 0)
  )
    return;
  const rooms = bodies.filter((entry) => entry.id !== body.id && entry.room);
  const room = rooms.find((entry) =>
    insideFootprint(
      relativePlacementBounds(body.bounds, body.transform, entry.transform).getCenter(
        new THREE.Vector3(),
      ),
      entry.room!,
    ),
  );
  let result = proposed;
  if (room) {
    const contained = contain(body, result, room);
    if (!contained) return;
    result = contained;
  } else if (
    rooms.some(
      (entry) =>
        relativePlacementBounds(body.bounds, result, entry.transform).intersectsBox(entry.bounds) ||
        crossesSolid(body, result, entry, entry.bounds),
    )
  ) {
    // An object starting outside cannot teleport through the exterior shell
    return;
  } else {
    const box = body.bounds.clone().applyMatrix4(placementMatrix(result));
    if (box.min.y < 0)
      result = {
        ...result,
        position: [result.position[0], result.position[1] - box.min.y, result.position[2]],
      };
  }
  for (const stand of bodies) {
    if (stand.id === body.id || !stand.display) continue;
    const box = relativePlacementBounds(body.bounds, result, stand.transform);
    const center = box.getCenter(new THREE.Vector3());
    const { top, interior } = stand.display;
    const horizontalOverlap =
      box.min.x < stand.bounds.max.x - EPSILON &&
      box.max.x > stand.bounds.min.x + EPSILON &&
      box.min.z < stand.bounds.max.z - EPSILON &&
      box.max.z > stand.bounds.min.z + EPSILON;
    const size = box.getSize(new THREE.Vector3());
    const footprint = interior ?? stand.bounds;
    const footprintFits =
      size.x <= footprint.max.x - footprint.min.x + EPSILON &&
      size.z <= footprint.max.z - footprint.min.z + EPSILON;
    if (!horizontalOverlap) {
      const base = stand.bounds.clone();
      base.max.y = top;
      if (
        crossesSolid(body, result, stand, base) ||
        (interior &&
          !fits(size, interior.getSize(new THREE.Vector3())) &&
          crossesSolid(body, result, stand, stand.bounds))
      )
        return;
      continue;
    }
    const inGlass =
      interior && box.max.y > top + EPSILON && box.min.y < stand.bounds.max.y + EPSILON;
    const inBase = box.min.y < top - EPSILON && box.max.y > stand.bounds.min.y + EPSILON;
    if (inGlass && !fits(size, interior.getSize(new THREE.Vector3()))) return;
    if (interior && (inGlass || inBase) && !footprintFits) return;
    if (!insideFootprint(center, stand.bounds) && !(inGlass && phase === "release")) {
      if (inBase) return;
      continue;
    }
    if (interior && inGlass) {
      if (phase === "release") {
        const target = interior.getCenter(new THREE.Vector3());
        result = shiftInFrame(
          result,
          new THREE.Vector3(target.x - center.x, top - box.min.y, target.z - center.z),
          stand.transform,
        );
      } else if (box.min.y < top) {
        result = shiftInFrame(result, new THREE.Vector3(0, top - box.min.y, 0), stand.transform);
      }
    } else if (inBase || (!interior && phase === "release" && box.min.y >= top)) {
      result = shiftInFrame(result, new THREE.Vector3(0, top - box.min.y, 0), stand.transform);
    }
  }
  if (room) {
    const checked = contain(body, result, room);
    // A support snap must not push an exhibit through the room to make it fit
    if (
      !checked ||
      checked.position.some((value, index) => Math.abs(value - result.position[index]!) > EPSILON)
    )
      return;
  }
  return result;
}

export function placementSupport(
  body: PlacementBody,
  transform: Transform,
  bodies: readonly PlacementBody[],
): string | undefined {
  return bodies.find((stand) => {
    if (stand.id === body.id || !stand.display) return false;
    const box = relativePlacementBounds(body.bounds, transform, stand.transform);
    const area = stand.display.interior ?? stand.bounds;
    return (
      Math.abs(box.min.y - stand.display.top) < EPSILON &&
      insideFootprint(box.getCenter(new THREE.Vector3()), area)
    );
  })?.id;
}
