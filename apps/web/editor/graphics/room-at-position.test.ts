import { expect, it } from "vitest";
import * as THREE from "three";
import { roomAtPosition } from "./room-at-position";
it("parents by the room under the placement, including rotated footprints and outside drops", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-5, -0.2, -5), new THREE.Vector3(5, 3, 5));
  const rooms = [
    { id: "Room 2", bounds, transform: new THREE.Matrix4().makeTranslation(10, 0, 0) },
    { id: "Room 1", bounds },
  ];
  expect(roomAtPosition([0, 0, 0], rooms)).toBe("Room 1");
  expect(roomAtPosition([10, 0, 0], rooms)).toBe("Room 2");
  expect(roomAtPosition([30, 0, 0], rooms)).toBeNull();
  const rotated = [
    {
      id: "Rotated room",
      bounds: new THREE.Box3(new THREE.Vector3(-2, -0.2, -4), new THREE.Vector3(2, 3, 4)),
      transform: new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 0, 0),
    },
  ];
  expect(roomAtPosition([13, 0, 0], rotated)).toBe("Rotated room");
  expect(roomAtPosition([10, 0, 3], rotated)).toBeNull();
});
