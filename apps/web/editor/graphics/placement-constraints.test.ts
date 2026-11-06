import { expect, it } from "vitest";
import * as THREE from "three";
import { resolveObjectPlacement, type PlacementBody } from "./placement-constraints";
import type { Transform } from "../../shared/project/project-types";

const box = (min: number[], max: number[]) =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
const pose = (position: Transform["position"] = [0, 0, 0]): Transform => ({
  position,
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});
const room: PlacementBody = {
  id: "room",
  transform: pose(),
  bounds: box([-5, -0.2, -5], [5, 3, 5]),
  room: box([-4.8, 0, -4.8], [4.8, 3, 4.8]),
};
const object: PlacementBody = {
  id: "object",
  transform: pose(),
  bounds: box([-0.1, 0, -0.1], [0.1, 0.2, 0.1]),
};
const glass: PlacementBody = {
  id: "case",
  transform: pose([1, 0, 0]),
  bounds: box([-0.3, 0, -0.3], [0.3, 2.4, 0.3]),
  display: { top: 1.2, interior: box([-0.29, 1.2, -0.29], [0.29, 2.39, 0.29]) },
};

it("prevents a moving room from overlapping another room or cutting through a loose object", () => {
  const moving = { ...room, id: "moving", transform: pose([-15, 0, 0]) };
  const stationary = { ...room, id: "stationary" };
  expect(resolveObjectPlacement(moving, pose([-4, 0, 0]), [stationary], "release")).toBeUndefined();
  const outside = { ...object, transform: pose([-5, 0.1, 0]) };
  expect(resolveObjectPlacement(moving, pose([-10, 0, 0]), [outside], "release")).toBeUndefined();
  expect(
    resolveObjectPlacement(moving, pose([-15, 0, 0]), [stationary, outside], "release"),
  ).toEqual(pose([-15, 0, 0]));
});

it("keeps the complete object inside every room side, floor and ceiling", () => {
  const constrained = resolveObjectPlacement(object, pose([50, -2, -50]), [room], "drag")!;
  expect(constrained.position[0]).toBeCloseTo(4.7);
  expect(constrained.position[1]).toBeCloseTo(0);
  expect(constrained.position[2]).toBeCloseTo(-4.7);
  expect(resolveObjectPlacement(object, pose([0, 50, 0]), [room], "drag")?.position[1]).toBeCloseTo(
    2.8,
  );
});
it("allows a fitting object through glass while held and seats it centrally only on release", () => {
  const proposed = pose([1.15, 1.5, 0.05]);
  expect(resolveObjectPlacement(object, proposed, [room, glass], "drag")).toEqual(proposed);
  const seated = resolveObjectPlacement(object, proposed, [room, glass], "release");
  expect(seated?.position[0]).toBeCloseTo(1);
  expect(seated?.position[1]).toBeCloseTo(1.2);
  expect(seated?.position[2]).toBeCloseTo(0);
  expect(seated?.scale).toEqual([1, 1, 1]);
});
it("rejects an oversized glass insertion rather than shrinking it", () => {
  const large = { ...object, bounds: box([-0.4, 0, -0.4], [0.4, 0.3, 0.4]) };
  expect(resolveObjectPlacement(large, pose([1, 1.3, 0]), [room, glass], "drag")).toBeUndefined();
});
it("seats an object on an open plinth without sinking into its solid base", () => {
  const stand = { ...glass, bounds: box([-0.3, 0, -0.3], [0.3, 1.2, 0.3]), display: { top: 1.2 } };
  expect(
    resolveObjectPlacement(object, pose([1, 0.8, 0]), [room, stand], "release")?.position,
  ).toEqual([1, 1.2, 0]);
});
it("uses transformed corners in a rotated room and rejects rotations too large for its volume", () => {
  const rotated = {
    ...room,
    transform: { ...pose([10, 0, 0]), rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const },
  };
  const moved = { ...object, transform: pose([10, 0, 0]) };
  expect(
    resolveObjectPlacement(moved, pose([30, 0, 0]), [rotated], "release")?.position[0],
  ).toBeCloseTo(14.7);
  expect(
    resolveObjectPlacement(
      { ...object, bounds: box([-6, 0, -1], [6, 1, 1]) },
      pose(),
      [room],
      "release",
    ),
  ).toBeUndefined();
});
it("cannot skip across a solid stand base in a single pointer update", () => {
  const moving = { ...object, transform: pose([-1, 0.3, 0]) };
  const stand = { ...glass, bounds: box([-0.3, 0, -0.3], [0.3, 1.2, 0.3]), display: { top: 1.2 } };
  expect(resolveObjectPlacement(moving, pose([3, 0.3, 0]), [room, stand], "drag")).toBeUndefined();
});
it("does not skip through glass when the dragged object is too large", () => {
  const moving = {
    ...object,
    bounds: box([-0.4, 0, -0.4], [0.4, 0.3, 0.4]),
    transform: pose([-1, 1.3, 0]),
  };
  expect(resolveObjectPlacement(moving, pose([3, 1.3, 0]), [room, glass], "drag")).toBeUndefined();
});
it("blocks a legacy exterior object from skipping through a whole room", () => {
  const exterior = { ...object, transform: pose([-8, 1, 0]) };
  expect(resolveObjectPlacement(exterior, pose([8, 1, 0]), [room], "drag")).toBeUndefined();
});
it("does not turn touching the stand into permission to pass through it", () => {
  const touching = { ...object, transform: pose([0.6, 0.3, 0]) };
  expect(
    resolveObjectPlacement(touching, pose([3, 0.3, 0]), [room, glass], "drag"),
  ).toBeUndefined();
});
it("does not leave a fitting object clipped through a glass side after release", () => {
  const proposed = pose([1.35, 1.5, 0]);
  expect(resolveObjectPlacement(object, proposed, [room, glass], "drag")).toEqual(proposed);
  const seated = resolveObjectPlacement(object, proposed, [room, glass], "release");
  expect(seated?.position[0]).toBeCloseTo(1);
  expect(seated?.position[1]).toBeCloseTo(1.2);
});
it("captures a fitting object overlapping the glass roof and seats it below the roof clearance", () => {
  const seated = resolveObjectPlacement(object, pose([1, 2.395, 0]), [room, glass], "release");
  expect(seated?.position[1]).toBeCloseTo(1.2);
});
