import { assert, it } from "vitest";
import * as THREE from "three";
import { axisRotation, beginAxisRotation, beginFreeRotation, freeRotation } from "./rotation";

const pivot = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const rayFrom = (camera: THREE.Vector3) => (point: THREE.Vector3) =>
  new THREE.Ray(camera, point.clone().sub(camera).normalize());

it("turns the object to follow the cursor around the chosen axis", () => {
  const camera = new THREE.Vector3(0, 10, 0);
  const rayTo = rayFrom(camera);
  const drag = beginAxisRotation(
    rayTo(new THREE.Vector3(1, 0, 0)),
    camera,
    pivot,
    up,
    new THREE.Quaternion(),
    0,
  );
  assert.equal(drag.mode, "plane");
  const rotation = axisRotation(drag, rayTo(new THREE.Vector3(0, 0, -1)), 0);
  assert.ok(rotation);
  const turned = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
  assert.ok(turned.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
});

it("keeps counting past a full turn", () => {
  const camera = new THREE.Vector3(0, 10, 0);
  const rayTo = rayFrom(camera);
  const drag = beginAxisRotation(
    rayTo(new THREE.Vector3(1, 0, 0)),
    camera,
    pivot,
    up,
    new THREE.Quaternion(),
    0,
  );
  for (let degrees = 10; degrees <= 370; degrees += 10) {
    const angle = THREE.MathUtils.degToRad(degrees);
    axisRotation(drag, rayTo(new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))), 0);
  }
  assert.ok(Math.abs(drag.totalAngle - THREE.MathUtils.degToRad(370)) < 1e-9);
});

it("uses horizontal mouse travel when the rotation plane is edge-on", () => {
  const camera = new THREE.Vector3(10, 0, 0);
  const drag = beginAxisRotation(
    rayFrom(camera)(pivot),
    camera,
    pivot,
    up,
    new THREE.Quaternion(),
    200,
  );
  assert.equal(drag.mode, "screen");
  const rotation = axisRotation(drag, rayFrom(camera)(pivot), 300);
  assert.ok(rotation);
  assert.ok(Math.abs(rotation.angleTo(new THREE.Quaternion()) - 1) < 1e-9);
});

it("snaps to the requested step", () => {
  const camera = new THREE.Vector3(10, 0, 0);
  const drag = beginAxisRotation(
    rayFrom(camera)(pivot),
    camera,
    pivot,
    up,
    new THREE.Quaternion(),
    0,
  );
  const step = THREE.MathUtils.degToRad(15);
  const rotation = axisRotation(drag, rayFrom(camera)(pivot), 30, step);
  assert.ok(rotation);
  assert.ok(Math.abs(rotation.angleTo(new THREE.Quaternion()) - step) < 1e-9);
});

it("turns around as the mouse moves", () => {
  const drag = beginFreeRotation(new THREE.Quaternion(), 0, 0);
  const rotation = freeRotation(drag, 100, 0, new THREE.Quaternion());
  const expected = new THREE.Quaternion().setFromAxisAngle(up, 1);
  assert.ok(rotation.angleTo(expected) < 1e-9);
});

it("follows where the mouse moved in", () => {
  const camera = new THREE.Quaternion();
  const rightThenUp = beginFreeRotation(new THREE.Quaternion(), 0, 0);
  freeRotation(rightThenUp, 100, 0, camera);
  const a = freeRotation(rightThenUp, 100, -100, camera);
  const upThenRight = beginFreeRotation(new THREE.Quaternion(), 0, 0);
  freeRotation(upThenRight, 0, -100, camera);
  const b = freeRotation(upThenRight, 100, -100, camera);
  assert.ok(a.angleTo(b) > 0.1, "Different paths should give different results");
});
