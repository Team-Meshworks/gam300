import { expect, it } from "vitest";
import * as THREE from "three";
import { textSurfacePlacement } from "./text-placement";
it("keeps a text preview within the front face and just above its surface", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1.2, 0.3));
  const placed = textSurfacePlacement(
    bounds,
    new THREE.Vector3(0.3, 1.2, 0.3),
    new THREE.Vector3(0, 0, 1),
  );
  expect(placed.position[0] + placed.scale[0] / 2).toBeCloseTo(0.3);
  expect(placed.position[1] + placed.scale[1] / 2).toBeCloseTo(1.2);
  expect(placed.position[2]).toBeGreaterThan(0.3);
  expect(placed.rotation).toEqual([0, 0, 0, 1]);
});
it("orients labels onto the top and side faces", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1.2, 0.3));
  for (const normal of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)]) {
    const placed = textSurfacePlacement(bounds, new THREE.Vector3(0, 0.6, 0), normal);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(
      new THREE.Quaternion(...placed.rotation),
    );
    expect(facing.dot(normal)).toBeCloseTo(1);
    expect(placed.scale.every((value) => value > 0)).toBe(true);
  }
});
