import type { QuaternionTuple, Vector3Tuple } from "../../shared/project/project-types";

const DEGREES = 180 / Math.PI;

// Same XYZ order as three.js so it match the gizmo
export function quaternionToDegrees([x, y, z, w]: QuaternionTuple): Vector3Tuple {
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const sinY = Math.min(1, Math.max(-1, m13));
  // Pointing straight up or down will lose one axis, so put the turn into X
  const angles: Vector3Tuple =
    Math.abs(sinY) > 0.9999999
      ? [Math.atan2(m32, m22), Math.asin(sinY), 0]
      : [Math.atan2(-m23, m33), Math.asin(sinY), Math.atan2(-m12, m11)];
  // Plus 0 so the panel wont show negative zero
  return [angles[0] * DEGREES + 0, angles[1] * DEGREES + 0, angles[2] * DEGREES + 0];
}

export function degreesToQuaternion([ax, ay, az]: Vector3Tuple): QuaternionTuple {
  const hx = ax / DEGREES / 2;
  const hy = ay / DEGREES / 2;
  const hz = az / DEGREES / 2;
  const [cx, cy, cz] = [Math.cos(hx), Math.cos(hy), Math.cos(hz)];
  const [sx, sy, sz] = [Math.sin(hx), Math.sin(hy), Math.sin(hz)];
  const quaternion = [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
  const length = Math.hypot(...quaternion);
  return quaternion.map((value) => value / length) as unknown as QuaternionTuple;
}
