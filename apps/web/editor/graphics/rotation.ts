import * as THREE from "three";

const MIN_PLANE_FACING = 0.2;
const RADIANS_PER_PIXEL = 0.01;

export type AxisRotation = {
  axis: THREE.Vector3;
  pivot: THREE.Vector3;
  startRotation: THREE.Quaternion;
  startX: number;
  // added so there wont be any lock
  lastAngle: number;
  totalAngle: number;
} & ({ mode: "plane"; plane: THREE.Plane; startVector: THREE.Vector3 } | { mode: "screen" });

export function beginAxisRotation(
  ray: THREE.Ray,
  cameraPosition: THREE.Vector3,
  pivot: THREE.Vector3,
  axis: THREE.Vector3,
  startRotation: THREE.Quaternion,
  clientX: number,
): AxisRotation {
  const base = {
    axis: axis.clone().normalize(),
    pivot: pivot.clone(),
    startRotation: startRotation.clone(),
    startX: clientX,
    lastAngle: 0,
    totalAngle: 0,
  };
  //normal is the rot axis
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(base.axis, pivot);
  const view = pivot.clone().sub(cameraPosition).normalize();
  const startVector = ray.intersectPlane(plane, new THREE.Vector3())?.sub(pivot);
  if (
    Math.abs(view.dot(base.axis)) < MIN_PLANE_FACING ||
    startVector === undefined ||
    startVector.lengthSq() < 1e-8
  ) {
    return { ...base, mode: "screen" };
  }
  return { ...base, mode: "plane", plane, startVector };
}

export function axisRotation(drag: AxisRotation, ray: THREE.Ray, clientX: number, snapRadians = 0) {
  let angle: number;
  if (drag.mode === "screen") {
    angle = (clientX - drag.startX) * RADIANS_PER_PIXEL;
  } else {
    const hit = ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (hit === null) return;
    const current = hit.sub(drag.pivot);
    if (current.lengthSq() < 1e-8) return;
    const raw = Math.atan2(
      drag.axis.dot(new THREE.Vector3().crossVectors(drag.startVector, current)),
      drag.startVector.dot(current),
    );
    let step = raw - drag.lastAngle;
    step -= Math.round(step / (2 * Math.PI)) * 2 * Math.PI;
    drag.lastAngle = raw;
    drag.totalAngle += step;
    angle = drag.totalAngle;
  }
  if (snapRadians > 0) {
    angle = Math.round(angle / snapRadians) * snapRadians;
  }
  return new THREE.Quaternion()
    .setFromAxisAngle(drag.axis, angle)
    .multiply(drag.startRotation)
    .normalize();
}

export type FreeRotation = {
  rotation: THREE.Quaternion;
  lastX: number;
  lastY: number;
};

export function beginFreeRotation(
  startRotation: THREE.Quaternion,
  clientX: number,
  clientY: number,
): FreeRotation {
  return { rotation: startRotation.clone(), lastX: clientX, lastY: clientY };
}

export function freeRotation(
  drag: FreeRotation,
  clientX: number,
  clientY: number,
  cameraQuaternion: THREE.Quaternion,
) {
  const dx = clientX - drag.lastX;
  const dy = clientY - drag.lastY;
  drag.lastX = clientX;
  drag.lastY = clientY;
  const turn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    dx * RADIANS_PER_PIXEL,
  );
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraQuaternion);
  const tilt = new THREE.Quaternion().setFromAxisAngle(cameraRight, dy * RADIANS_PER_PIXEL);
  drag.rotation.premultiply(turn).premultiply(tilt).normalize();
  return drag.rotation.clone();
}
