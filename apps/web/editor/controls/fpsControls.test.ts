import { expect, it, onTestFinished } from "vitest";
import * as THREE from "three";
import { FpsControls } from "./fpsControls";

it("distinguishes held movement from inertia without changing the camera trajectory", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.y = 0.9;
  const controls = new FpsControls(camera, document.createElement("canvas"));
  onTestFinished(() => controls.dispose());
  controls.engage();
  controls.mobileControls.setMove(1, 0);
  expect(controls.hasMovementInput()).toBe(true);
  for (let i = 0; i < 36; i++) controls.update(1 / 60);
  expect(camera.position.x).toBeGreaterThan(1);
  controls.mobileControls.setMove(0, 0);
  expect(controls.hasMovementInput()).toBe(false);
  const released = camera.position.clone();
  for (let i = 0; i < 6; i++) controls.update(1 / 60);
  expect(camera.position.distanceTo(released)).toBeGreaterThan(0.05);
  expect(controls.hasMovementInput()).toBe(false);
  controls.mobileControls.setMove(1, 0);
  expect(controls.hasMovementInput()).toBe(true);
  for (let i = 0; i < 6; i++) controls.update(1 / 60);
  expect(camera.position.distanceTo(released)).toBeGreaterThan(0.1);
});

it("keeps a mobile jump until a physics step can consume it", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.y = 0.9;
  const controls = new FpsControls(camera, document.createElement("canvas"));
  onTestFinished(() => controls.dispose());
  controls.engage();
  controls.mobileControls.jump();
  controls.update(0);
  for (let i = 0; i < 4; i++) controls.update(1 / 1000);
  expect(camera.position.y).toBeCloseTo(0.9);
  controls.update(1 / 60);
  expect(camera.position.y).toBeGreaterThan(0.9);
  for (let i = 0; i < 120; i++) controls.update(1 / 60);
  expect(camera.position.y).toBeCloseTo(0.9);
});

it.each([
  [0.2, 0.3],
  [4, 0.3],
  [0.2, Math.PI / 2],
  [4, -Math.PI / 2],
])(
  "keeps a teleported visitor at height %s and pitch %s across physics frames",
  (height, pitch) => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const controls = new FpsControls(camera, document.createElement("canvas"));
    onTestFinished(() => controls.dispose());
    controls.engage();
    controls.update(0.1);
    camera.position.set(20, height, -12);
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, 1.2, 0.2, "YXZ"));
    const pose = camera.clone();
    controls.syncFromCamera();
    for (let i = 0; i < 60; i++) controls.update(1 / 60);
    expect(camera.position.distanceTo(pose.position)).toBeLessThan(1e-9);
    expect(camera.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
  },
);
