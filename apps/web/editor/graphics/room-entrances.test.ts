import { expect, it } from "vitest";
import * as THREE from "three";
import { createRoomEntrances } from "./room-entrances";

function room(x = 0, z = 0, yaw = 0) {
  const root = new THREE.Group();
  for (const [name, px, pz, width, depth] of [
    ["Wall_Back", 0, -4.9, 10, 0.2],
    ["Wall_Front", 0, 4.9, 10, 0.2],
    ["Wall_Left", -4.9, 0, 0.2, 10],
    ["Wall_Right", 4.9, 0, 0.2, 10],
  ] as const) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(width, 3, depth),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    wall.name = name;
    wall.position.set(px, 1.5, pz);
    root.add(wall);
  }
  root.position.set(x, 0, z);
  root.rotation.y = yaw;
  return root;
}
function hits(rooms: THREE.Group[], origin: number[], direction: number[], distance = 2) {
  for (const room of rooms) room.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(
    new THREE.Vector3(...origin),
    new THREE.Vector3(...direction),
    0,
    distance,
  );
  return ray.intersectObjects(rooms, true);
}

it("opens both shared walls, leaves jambs/lintel intact, and restores walls on separation/undo/removal", () => {
  const a = room(),
    b = room(10);
  const original = a.getObjectByName("Wall_Right") as THREE.Mesh;
  const geometry = original.geometry;
  const dispose = createRoomEntrances();
  dispose.sync([a, b]);
  expect(hits([a, b], [4, 1.5, 0], [1, 0, 0])).toHaveLength(0);
  expect(hits([a, b], [4, 1.5, 2], [1, 0, 0]).length).toBeGreaterThan(0);
  expect(hits([a, b], [4, 2.8, 0], [1, 0, 0]).length).toBeGreaterThan(0);
  expect(geometry.getAttribute("position").count).toBe(24);
  const opened = original.geometry;
  dispose.sync([a, b]);
  expect(original.geometry).toBe(opened);
  b.position.x = 20;
  dispose.sync([a, b]);
  expect(original.geometry).toBe(geometry);
  b.position.x = 10;
  dispose.sync([a, b]);
  expect(hits([a, b], [4, 1.5, 0], [1, 0, 0])).toHaveLength(0);
  dispose.sync([a]);
  expect(original.geometry).toBe(geometry);
  dispose.dispose();
});

it("connects three rooms through two entrances, including a rotated room, without opening exterior walls", () => {
  const rooms = [room(), room(10, 0, Math.PI / 2), room(10, 10)];
  const entrances = createRoomEntrances();
  entrances.sync(rooms);
  expect(hits(rooms, [4, 1.5, 0], [1, 0, 0])).toHaveLength(0);
  expect(hits(rooms, [10, 1.5, 4], [0, 0, 1])).toHaveLength(0);
  expect(hits(rooms, [-4, 1.5, 0], [-1, 0, 0]).length).toBeGreaterThan(0);
  entrances.dispose();
  expect(hits(rooms, [4, 1.5, 0], [1, 0, 0]).length).toBeGreaterThan(0);
});

it("does not connect offset, elevated, tilted or scaled rooms", () => {
  const entrances = createRoomEntrances();
  const offset = room(10, 1),
    elevated = room(10),
    tilted = room(10);
  elevated.position.y = 0.1;
  tilted.rotation.x = 0.1;
  for (const b of [offset, elevated, tilted]) {
    const a = room();
    entrances.sync([a, b]);
    expect(hits([a, b], [4, 1.5, 0], [1, 0, 0]).length).toBeGreaterThan(0);
  }
  const a = room(),
    b = room(10);
  b.scale.setScalar(2);
  entrances.sync([a, b]);
  expect(
    (a.getObjectByName("Wall_Right") as THREE.Mesh).geometry.getAttribute("position").count,
  ).toBe(24);
  entrances.dispose();
});
