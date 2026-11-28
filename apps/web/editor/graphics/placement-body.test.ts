import { expect, it } from "vitest";
import * as THREE from "three";
import { placementBody } from "./placement-body";
import { resolveObjectPlacement } from "./placement-constraints";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";

const pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
const asset: CatalogueAsset = {
  id: "case",
  kind: "model",
  name: "Case",
  url: "case.glb",
  sha256: "0".repeat(64),
  thumbnail: null,
  displayRole: "physical",
  displayTop: 0.2,
};
it("caps a glass compartment below an opaque shelf instead of fitting through it", () => {
  const model = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.6));
  base.position.y = 0.1;
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 2.2, 0.6),
    new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.2 }),
  );
  glass.position.y = 1.3;
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.02, 0.56));
  shelf.position.y = 1.2;
  model.add(base, glass, shelf);
  const body = placementBody("case", pose, model, asset);
  expect(body.display?.interior?.min.y).toBeCloseTo(0.2);
  expect(body.display?.interior?.max.y).toBeLessThan(1.2);
  expect(body.display?.interior?.max.y).toBeCloseTo(1.19, 2);
});
it("keeps an open plinth open and measures its full solid bounds", () => {
  const model = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.6));
  base.position.y = 0.6;
  model.add(base);
  const body = placementBody("stand", pose, model, { ...asset, displayTop: 1.2 });
  expect(body.display?.interior).toBeUndefined();
  expect(body.display?.top).toBe(1.2);
  expect(body.bounds.min.y).toBeCloseTo(0);
});

const crate = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));

function slab(top: number, width = 6, thickness = 0.1) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, thickness, 6));
  mesh.name = "floor";
  mesh.position.y = top - thickness / 2;
  return mesh;
}

function roomPlacement(...meshes: THREE.Mesh[]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 4, 6));
  wall.position.set(3, 2, 0);
  const model = new THREE.Group().add(...meshes, wall);
  const room = placementBody("room", pose, model, {
    id: "room",
    kind: "environment",
    name: "Room",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  });
  const floor = room.floorAtTransform!(new THREE.Matrix4());
  function place(x: number, eyeY: number, z: number) {
    const ray = new THREE.Ray(new THREE.Vector3(x, eyeY, z), new THREE.Vector3(0, -1, 0));
    const hit = floor.intersect(ray);
    if (!hit) return;
    const transform = { ...pose, position: [x, hit.y, z] as const };
    const body = { id: "crate", bounds: crate, transform };
    const released = resolveObjectPlacement(body, transform, [room], "release", hit.y);
    return { hit: hit.y, base: released?.position[1], x: released?.position[0] };
  }
  return { room, place };
}

it("supports a new crate and one moved uphill on the same pitched floor", () => {
  const mesh = slab(0.1);
  const pitch = THREE.MathUtils.degToRad(5);
  mesh.rotation.x = pitch;
  const { room, place } = roomPlacement(mesh);
  const topAt = (z: number) => mesh.position.y + 0.05 / Math.cos(pitch) - z * Math.tan(pitch);
  const startY = topAt(-0.5);
  expect(place(0, 1.7, 0)?.base).toBeCloseTo(startY, 5);
  const placed = place(0, 1.7, -2);
  expect(placed?.hit).toBeCloseTo(topAt(-2), 5);
  expect(placed?.base).toBeCloseTo(topAt(-2.5), 5);
  const transform = { ...pose, position: [0, startY, 0] as const };
  const body = { id: "crate", bounds: crate, transform };
  const uphill = { ...transform, position: [0, startY, -2] as const };
  for (const phase of ["drag", "release"] as const) {
    const moved = resolveObjectPlacement(body, uphill, [room], phase);
    expect(moved?.position[2]).toBe(-2);
    expect(moved?.position[1]).toBeCloseTo(topAt(-2.5), 5);
  }
});

it("selects the lower floor or the imported Mezzanine deck from the camera's storey", () => {
  const deck = slab(2.5, 3, 0.2);
  deck.name = "Mezzanine";
  const { place, room } = roomPlacement(slab(0.1), deck);
  const lower = place(0, 1.7, 0);
  expect(lower?.hit).toBeCloseTo(0.1);
  expect(lower?.base).toBeCloseTo(0.1);
  const upper = place(0, 3.5, 0);
  expect(upper?.hit).toBeCloseTo(2.5);
  expect(upper?.base).toBeCloseTo(2.5);
  const transform = { ...pose, position: [0, 0.1, 0] as const };
  const body = { id: "crate", bounds: crate, transform };
  const move = (x: number, y: number) =>
    resolveObjectPlacement(body, { ...pose, position: [x, y, 0] }, [room], "release");
  expect(move(0, 1.3)?.position[1]).toBeCloseTo(1.3);
  expect(move(2, 1.45)?.position).toEqual([2, 1.45, 0]);
  for (const [x, y] of [
    [0, 1.45],
    [1.75, 1.45],
    [0, 1.6],
  ] as const) {
    expect(move(x, y)).toBeUndefined();
  }
});

function leftWall(height: number) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.25, height, 6));
  wall.name = "Wall_Left";
  wall.position.set(-2.875, height / 2, 0);
  return wall;
}

it("seats a crate on an overlapping strip and keeps it on the floor beside a wall", () => {
  const strip = slab(0.3, 0.18);
  strip.name = "raised-strip";
  strip.position.x = 0.27;
  const { place } = roomPlacement(slab(0.1), strip, leftWall(2.5));
  const overlapping = place(0, 1.7, 0);
  expect(overlapping?.hit).toBeCloseTo(0.1);
  expect(overlapping?.base).toBeCloseTo(0.3);
  expect(place(1, 1.7, 0)?.base).toBeCloseTo(0.1);
  expect(place(-2.24, 1.7, 0)?.base).toBeCloseTo(0.1);
  const flush = place(-2.5, 1.7, 0);
  expect(flush?.hit).toBeCloseTo(0.1);
  expect(flush?.x).toBeCloseTo(-2.25);
  expect(flush?.base).toBeCloseTo(0.1);

  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  const rotated = { ...pose, rotation: yaw.toArray() };
  const body = {
    id: "crate",
    bounds: crate,
    transform: { ...rotated, position: [0, 0.1, 0] as const },
  };
  const position = new THREE.Vector3(-2.24, 0.1, 0).applyQuaternion(yaw).toArray();
  for (const height of [2.5, 4]) {
    const { room } = roomPlacement(slab(0.1), leftWall(height));
    const moved = resolveObjectPlacement(
      body,
      { ...rotated, position },
      [{ ...room, transform: rotated }],
      "release",
    );
    expect
      .soft(moved?.position, `wall height ${height} m`)
      .toEqual(position.map((value) => expect.closeTo(value, 5)));
  }
});
