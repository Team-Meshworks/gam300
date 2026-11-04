import { expect, it } from "vitest";
import * as THREE from "three";
import { fitDisplayedObject } from "./fit-displayed-object";
it("fits wide objects inside a case and applies the case rotation and scale", () => {
  const owner = {
    id: "case",
    assetId: "case",
    name: "Case",
    transform: {
      position: [2, 0, 3] as const,
      rotation: [0, 0, 0, 1] as const,
      scale: [2, 2, 2] as const,
    },
  };
  const fitted = fitDisplayedObject(
    owner,
    0.2,
    new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 2.4, 0.3)),
    new THREE.Box3(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(2, 3, 1)),
  );
  expect(fitted.position).toEqual([2, 0.4, 3]);
  expect(fitted.scale[0] * 4).toBeCloseTo(1.08);
  expect(fitted.rotation).toEqual(owner.transform.rotation);
});
it("does not enlarge small objects or mutate the original bounds", () => {
  const owner = {
    id: "case",
    assetId: "case",
    name: "Case",
    transform: {
      position: [0, 0, 0] as const,
      rotation: [0, 0, 0, 1] as const,
      scale: [1, 1, 1] as const,
    },
  };
  const bounds = new THREE.Box3(new THREE.Vector3(-0.1, 0, -0.1), new THREE.Vector3(0.1, 0.2, 0.1));
  expect(
    fitDisplayedObject(
      owner,
      1.2,
      new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1.2, 0.3)),
      bounds,
    ).scale,
  ).toEqual([1, 1, 1]);
  expect(bounds.max.y).toBe(0.2);
});
