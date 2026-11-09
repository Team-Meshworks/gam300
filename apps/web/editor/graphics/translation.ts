import * as THREE from "three";

export function beginAxisDrag(
  ray: THREE.Ray,
  cameraPosition: THREE.Vector3,
  pivot: THREE.Vector3,
  axis: THREE.Vector3,
) {
  // Remove the axis component of the view vector to make a fixed plane containing the axis.
  const normal = cameraPosition.clone().sub(pivot);
  normal.addScaledVector(axis, -normal.dot(axis));
  if (normal.lengthSq() < 1e-8) return;
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), pivot);
  const startHit = ray.intersectPlane(plane, new THREE.Vector3());
  if (startHit === null) return;
  return { plane, startHit, axis: axis.clone(), startPosition: pivot.clone() };
}

export function axisDragPosition(
  drag: NonNullable<ReturnType<typeof beginAxisDrag>>,
  ray: THREE.Ray,
) {
  const hit = ray.intersectPlane(drag.plane, new THREE.Vector3());
  if (hit === null) return;
  const position = drag.startPosition
    .clone()
    .addScaledVector(drag.axis, hit.sub(drag.startHit).dot(drag.axis));
  if (position.toArray().some((value) => !Number.isFinite(value) || Math.abs(value) > 10_000)) {
    return;
  }
  return position;
}
