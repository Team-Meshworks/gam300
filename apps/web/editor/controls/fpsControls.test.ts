import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { FpsControls } from "./fpsControls";

afterEach(() => vi.unstubAllGlobals());

it.each([0.2, 4])(
  "keeps a teleported visitor at height %s across subsequent physics frames",
  (height) => {
    const events = new EventTarget();
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const controls = new FpsControls(camera, new EventTarget() as HTMLElement);
    controls.engage();
    controls.update(0.1);
    camera.position.set(20, height, -12);
    camera.quaternion.setFromEuler(new THREE.Euler(0.3, 1.2, 0.2, "YXZ"));
    const pose = camera.clone();
    controls.syncFromCamera();
    for (let i = 0; i < 60; i++) controls.update(1 / 60);
    expect(camera.position.distanceTo(pose.position)).toBeLessThan(1e-9);
    expect(camera.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
    controls.dispose();
  },
);
