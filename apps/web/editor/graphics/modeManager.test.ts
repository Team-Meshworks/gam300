import { assert, it, vi } from "vitest";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EYE_HEIGHT, FpsControls } from "../controls/fpsControls";
import { ModeManager } from "./modeManager";

// Only the parts ModeManager touches, the real controls need a DOM
function setup() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(12, 16, 18);
  const orbit = { enabled: true, target: new THREE.Vector3(), update: vi.fn() };
  let engaged = false;
  const fps = {
    onCaptureChange: () => undefined,
    canCapture: () => false,
    isCaptured: () => false,
    isEngaged: () => engaged,
    engage: () => {
      engaged = true;
    },
    disengage: () => {
      engaged = false;
    },
    sync: vi.fn(),
    syncFromCamera: vi.fn(),
    lookAt: (target: THREE.Vector3) => camera.lookAt(target),
    update: vi.fn(),
  };
  const manager = new ModeManager(
    camera,
    orbit as unknown as OrbitControls,
    fps as unknown as FpsControls,
  );
  return { camera, orbit, fps, manager };
}

const savedPosition = [0, 2, 10] as const;
const savedRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.5, 0, "YXZ"));

function restoreSavedCamera({ camera, orbit, manager }: ReturnType<typeof setup>) {
  camera.position.fromArray(savedPosition);
  camera.quaternion.copy(savedRotation);
  orbit.target.set(1, 1, 1);
  manager.resetView();
}

it("restoring a saved camera in first person keeps its pose", () => {
  const context = setup();
  context.manager.initializeView("first");

  restoreSavedCamera(context);

  assert.deepEqual(context.camera.position.toArray(), [...savedPosition]);
  assert.ok(context.camera.quaternion.equals(savedRotation));
  // The walking controller has to pick the pose up, or its next update overwrites it
  assert.equal(context.fps.syncFromCamera.mock.calls.length, 1);
  assert.ok(context.fps.isEngaged());
});

it("third person returns to the restored camera, not the one before it", () => {
  const context = setup();
  context.manager.initializeView("first");
  restoreSavedCamera(context);

  context.camera.position.set(4, EYE_HEIGHT, 4);
  context.manager.setView("third");

  assert.deepEqual(context.camera.position.toArray(), [...savedPosition]);
  assert.ok(context.camera.quaternion.equals(savedRotation));
  assert.deepEqual(context.orbit.target.toArray(), [1, 1, 1]);
  assert.equal(context.orbit.enabled, true);
});

it("switching to first person still stands on the floor at the orbit target", () => {
  const context = setup();
  context.manager.initializeView("third");
  context.orbit.target.set(3, 0, -2);

  context.manager.setView("first");

  assert.deepEqual(context.camera.position.toArray(), [3, EYE_HEIGHT, -2]);
  assert.equal(context.orbit.enabled, false);
});

it("restoring a camera in third person leaves the orbit camera alone", () => {
  const context = setup();
  context.manager.initializeView("third");

  restoreSavedCamera(context);

  assert.equal(context.fps.syncFromCamera.mock.calls.length, 0);
  assert.equal(context.fps.isEngaged(), false);
});

it("restoring a saved first-person pose drops movement from the old view", () => {
  const events = new EventTarget();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 2, 10);
  const orbit = { enabled: true, target: new THREE.Vector3(), update() {} };
  const fps = new FpsControls(camera, new EventTarget() as HTMLElement);
  const manager = new ModeManager(camera, orbit as unknown as OrbitControls, fps);
  try {
    manager.initializeView("first");
    const before = camera.position.clone();
    fps.mobileControls.setMove(1, 0);
    manager.update(0.1);
    assert.ok(camera.position.distanceTo(before) > 0.1);
    camera.position.fromArray(savedPosition);
    camera.quaternion.copy(savedRotation);
    manager.resetView();
    for (let i = 0; i < 60; i++) manager.update(1 / 60);
    assert.ok(camera.position.distanceTo(new THREE.Vector3(...savedPosition)) < 1e-9);
    assert.ok(camera.quaternion.angleTo(savedRotation) < 1e-6);
  } finally {
    fps.dispose();
    vi.unstubAllGlobals();
  }
});
