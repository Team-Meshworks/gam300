import { expect, it, onTestFinished } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EYE_HEIGHT, FpsControls } from "../controls/fpsControls";
import { ModeManager } from "./modeManager";

function setup() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(12, 16, 18);
  const canvas = document.createElement("canvas");
  const orbit = new OrbitControls(camera, canvas);
  const fps = new FpsControls(camera, canvas);
  const manager = new ModeManager(camera, orbit, fps);
  onTestFinished(() => {
    fps.dispose();
    orbit.dispose();
  });
  return { camera, orbit, fps, manager };
}

const savedPosition = new THREE.Vector3(0, 2, 10);
const savedRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.5, 0, "YXZ"));
const savedTarget = new THREE.Vector3(0, 0, -1)
  .applyQuaternion(savedRotation)
  .multiplyScalar(8)
  .add(savedPosition);

function restoreSavedCamera({ camera, orbit, manager }: ReturnType<typeof setup>) {
  camera.position.copy(savedPosition);
  camera.quaternion.copy(savedRotation);
  camera.fov = 45;
  orbit.target.copy(savedTarget);
  manager.resetView();
}

function expectSavedPose(camera: THREE.PerspectiveCamera) {
  expect(camera.position.distanceTo(savedPosition)).toBeLessThan(1e-9);
  expect(camera.quaternion.angleTo(savedRotation)).toBeLessThan(1e-6);
}

it("restoring a saved camera in first person keeps its pose through the next update", () => {
  const context = setup();
  context.manager.initializeView("first");
  restoreSavedCamera(context);
  context.manager.update(1 / 60);

  expectSavedPose(context.camera);
  expect(context.fps.isEngaged()).toBe(true);
});

it("third person returns to the restored camera, not the one before it", () => {
  const context = setup();
  context.manager.initializeView("first");
  restoreSavedCamera(context);

  context.camera.position.set(4, EYE_HEIGHT, 4);
  context.manager.setView("third");

  expectSavedPose(context.camera);
  expect(context.orbit.target.distanceTo(savedTarget)).toBeLessThan(1e-9);
  expect(context.orbit.enabled).toBe(true);
  expect(context.camera.fov).toBe(45);
});

it("switching to first person still stands on the floor at the orbit target", () => {
  const context = setup();
  context.manager.initializeView("third");
  context.orbit.target.set(3, 0, -2);

  context.manager.setView("first");

  expect(context.camera.position.toArray()).toEqual([3, EYE_HEIGHT, -2]);
  expect(context.orbit.enabled).toBe(false);
});

it("restoring a camera in third person leaves the orbit camera alone", () => {
  const context = setup();
  context.manager.initializeView("third");
  restoreSavedCamera(context);
  context.manager.update(1 / 60);

  expectSavedPose(context.camera);
  expect(context.camera.fov).toBe(45);
  expect(context.fps.isEngaged()).toBe(false);
});

it("restoring a saved first-person pose drops movement from the old view", () => {
  const context = setup();
  const { camera, fps, manager } = context;
  manager.initializeView("first");
  const before = camera.position.clone();
  fps.mobileControls.setMove(1, 0);
  manager.update(0.1);
  expect(camera.position.distanceTo(before)).toBeGreaterThan(0.1);
  restoreSavedCamera(context);
  for (let i = 0; i < 60; i++) manager.update(1 / 60);
  expectSavedPose(camera);
});
