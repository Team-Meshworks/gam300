import type { CameraPose, QuaternionTuple, Transform, Vector3Tuple } from "./project-types";

import { checkFields, invalid, isRecord } from "./validation-helpers";
import type { ValidationResult } from "./validation-helpers";

export type { ValidationResult } from "./validation-helpers";

const MAX_POSITION_METRES = 10_000;
const MIN_FOV_DEGREES = 30;
const MAX_FOV_DEGREES = 90;

// Allow small rounding drift from rotation calculations
// Anything further from unit length needs fixing at the source
const QUATERNION_LENGTH_TOLERANCE = 0.000001;

function isFiniteNumber(value: unknown): value is number {
  // Reject numeric strings too; converting them would hide a malformed file
  return typeof value === "number" && Number.isFinite(value);
}

function isVector3(value: unknown): value is Vector3Tuple {
  // Check each slot directly so holes in an array get caught
  // Array every skips those holes
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    isFiniteNumber(value[2])
  );
}

function isQuaternion(value: unknown): value is QuaternionTuple {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    isFiniteNumber(value[2]) &&
    isFiniteNumber(value[3])
  );
}

function validatePosition(raw: unknown, path: string): ValidationResult<Vector3Tuple> {
  if (!isVector3(raw)) {
    return invalid(path, "Position must contain three finite numbers");
  }
  for (const [index, value] of raw.entries()) {
    // Limit each axis separately; negative positions are valid
    if (Math.abs(value) > MAX_POSITION_METRES) {
      return invalid(`${path}[${index}]`, "Position must be between -10000 and 10000 metres");
    }
  }
  return { ok: true, value: [...raw] };
}

function validateRotation(raw: unknown, path: string): ValidationResult<QuaternionTuple> {
  if (!isQuaternion(raw)) {
    return invalid(path, "Rotation must contain four finite numbers in x, y, z, w order");
  }

  // Check length before dividing; a zero quaternion has no rotation to recover
  // hypot avoids overflow from squaring very large components
  const length = Math.hypot(...raw);
  if (!Number.isFinite(length) || Math.abs(length - 1) > QUATERNION_LENGTH_TOLERANCE) {
    return invalid(path, "Rotation must be a unit quaternion within 0.000001 of length 1");
  }

  // Copy before normalizing so validation leaves the imported values alone
  const [x, y, z, w] = raw;
  return { ok: true, value: [x / length, y / length, z / length, w / length] };
}

// Path can point to an object inside a project when the project reader calls this
// Return the first problem so the caller can explain which field needs fixing
export function validateTransform(raw: unknown, path = "transform"): ValidationResult<Transform> {
  if (!isRecord(raw)) {
    return invalid(path, "Transform must be an object");
  }
  // Check the record shape first, then validate each spatial value
  const fields = checkFields(raw, ["position", "rotation", "scale"], path);
  if (!fields.ok) {
    return fields;
  }
  const position = validatePosition(raw.position, `${path}.position`);
  if (!position.ok) {
    return position;
  }
  const rotation = validateRotation(raw.rotation, `${path}.rotation`);
  if (!rotation.ok) {
    return rotation;
  }
  if (!isVector3(raw.scale)) {
    return invalid(`${path}.scale`, "Scale must contain three finite numbers");
  }
  for (const [index, value] of raw.scale.entries()) {
    // Zero collapses an axis; negative scale mirrors it
    // M1 stores positive scale on every axis
    if (value <= 0) {
      return invalid(`${path}.scale[${index}]`, "Scale must be greater than zero");
    }
  }

  // Fresh arrays keep later edits from changing the caller's input
  return {
    ok: true,
    value: { position: position.value, rotation: rotation.value, scale: [...raw.scale] },
  };
}

export function validateCameraPose(
  raw: unknown,
  path = "startCamera",
): ValidationResult<CameraPose> {
  if (!isRecord(raw)) {
    return invalid(path, "Camera pose must be an object");
  }
  // Camera and object poses share the same coordinate and rotation rules
  const fields = checkFields(raw, ["position", "rotation", "fovDegrees"], path);
  if (!fields.ok) {
    return fields;
  }
  const position = validatePosition(raw.position, `${path}.position`);
  if (!position.ok) {
    return position;
  }
  const rotation = validateRotation(raw.rotation, `${path}.rotation`);
  if (!rotation.ok) {
    return rotation;
  }
  // Field of view stays in degrees in the saved format
  // Both endpoints of the 30 to 90 range are allowed
  if (
    !isFiniteNumber(raw.fovDegrees) ||
    raw.fovDegrees < MIN_FOV_DEGREES ||
    raw.fovDegrees > MAX_FOV_DEGREES
  ) {
    return invalid(`${path}.fovDegrees`, "Field of view must be between 30 and 90 degrees");
  }
  return {
    ok: true,
    value: { position: position.value, rotation: rotation.value, fovDegrees: raw.fovDegrees },
  };
}
