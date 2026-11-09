import { expect, it } from "vitest";
import * as THREE from "three";
import { fitDisplayedObject } from "./fit-displayed-object";
it("rejects wide objects instead of automatically shrinking them into a case", () => {
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
  expect(fitted).toBeUndefined();
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
    )?.scale,
  ).toEqual([1, 1, 1]);
  expect(bounds.max.y).toBe(0.2);
});
it("centres an off-pivot object and seats its actual bottom on the base", () => {
  const owner = {
    id: "case",
    assetId: "case",
    name: "Case",
    transform: {
      position: [2, 0, 3] as const,
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const,
      scale: [2, 2, 2] as const,
    },
  };
  const model = new THREE.Box3(new THREE.Vector3(2, -1, -0.1), new THREE.Vector3(2.2, -0.8, 0.1));
  const result = fitDisplayedObject(
    owner,
    0.2,
    new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 2.4, 0.3)),
    model,
  )!;
  const world = model
    .clone()
    .applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...result.position),
        new THREE.Quaternion(...result.rotation),
        new THREE.Vector3(...result.scale),
      ),
    );
  expect(world.min.y).toBeCloseTo(0.4);
  expect(world.getCenter(new THREE.Vector3()).x).toBeCloseTo(2);
  expect(world.getCenter(new THREE.Vector3()).z).toBeCloseTo(3);
  expect(result.scale).toEqual([1, 1, 1]);
});
it("reserves the actual side-pane thickness instead of admitting an object into the glass", () => {
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
  expect(
    fitDisplayedObject(
      owner,
      0.2,
      new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 2.4, 0.3)),
      new THREE.Box3(new THREE.Vector3(-0.285, 0, -0.1), new THREE.Vector3(0.285, 0.2, 0.1)),
    ),
  ).toBeUndefined();
});
