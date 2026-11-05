import * as THREE from "three";
import type { Transform } from "../../shared/project/project-types";

// Keep the label inside the face being pointed at, in the case's local coordinates.
export function textSurfacePlacement(
  bounds: THREE.Box3,
  point: THREE.Vector3,
  normal: THREE.Vector3,
): Transform {
  const facing = normal.clone().normalize();
  const up = Math.abs(facing.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = up.clone().cross(facing).normalize();
  up.copy(facing).cross(right).normalize();
  const size = bounds.getSize(new THREE.Vector3());
  const extent = (axis: THREE.Vector3) =>
    Math.abs(axis.x) * size.x + Math.abs(axis.y) * size.y + Math.abs(axis.z) * size.z;
  const width = Math.max(0.01, extent(right) * 0.85),
    height = Math.max(0.01, Math.min(extent(up) * 0.8, width * 0.6));
  const center = bounds.getCenter(new THREE.Vector3()),
    offset = point.clone().sub(center),
    position = point.clone();
  for (const [axis, length] of [
    [right, width],
    [up, height],
  ] as const) {
    const limit = Math.max(0, (extent(axis) - length) / 2),
      value = offset.dot(axis);
    position.addScaledVector(axis, THREE.MathUtils.clamp(value, -limit, limit) - value);
  }
  position.addScaledVector(facing, 0.003);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, facing),
  );
  return { position: position.toArray(), rotation: rotation.toArray(), scale: [width, height, 1] };
}
