import { assert, it } from "vitest";
import * as THREE from "three";
import { axisDragPosition, beginAxisDrag } from "./translation";

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
