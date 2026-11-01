import { assert, it } from "vitest";
import * as THREE from "three";
import {
  axisDragPosition,
  beginAxisDrag,
  HALF_GRID_SNAP,
  snapAlongAxis,
  snapToGrid,
} from "./translation";

it("snaps to the nearest half grid cell", () => {
  assert.equal(HALF_GRID_SNAP, 0.5);
  assert.equal(snapToGrid(0.24), 0);
  assert.equal(snapToGrid(0.26), 0.5);
  assert.equal(snapToGrid(-0.76), -1);
});

it("snaps only the components of the dragged axis", () => {
  const position = new THREE.Vector3(1.26, 2.26, -3.24);
  snapAlongAxis(position, new THREE.Vector3(1, 0, 0));
  assert.deepEqual(position.toArray(), [1.5, 2.26, -3.24]);
});

it("moves only on the chosen axis and declines degenerate rays", () => {
  const camera = new THREE.Vector3(12, 16, 18);
  const pivot = new THREE.Vector3(1, 0, -2);
  const axis = new THREE.Vector3(1, 0, 0);
  const rayTo = (point: THREE.Vector3) =>
    new THREE.Ray(camera, point.clone().sub(camera).normalize());
  const drag = beginAxisDrag(rayTo(pivot.clone().addScaledVector(axis, 0.5)), camera, pivot, axis);
  assert.ok(drag);
  const moved = axisDragPosition(drag, rayTo(pivot.clone().addScaledVector(axis, 2.5)));
  assert.ok(moved);
  assert.ok(moved.distanceTo(new THREE.Vector3(3, 0, -2)) < 1e-9);
  assert.equal(
    beginAxisDrag(
      new THREE.Ray(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1)),
      new THREE.Vector3(0, 0, 10),
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, 1),
    ),
    undefined,
  );
  assert.equal(
    axisDragPosition(drag, new THREE.Ray(camera, drag.axis)),
    undefined,
    "A ray parallel to the drag plane holds the last valid position",
  );
});
