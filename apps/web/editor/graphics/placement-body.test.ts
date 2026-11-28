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

function slab(top: number, width = 6) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.1, 6));
  mesh.name = "floor";
  mesh.position.y = top - 0.05;
  return mesh;
}

function roomPlacement(...slabs: THREE.Mesh[]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 4, 6));
  wall.position.set(-3, 2, 0);
  const model = new THREE.Group().add(...slabs, wall);
  const room = placementBody("room", pose, model, {
    id: "room",
    kind: "environment",
    name: "Room",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  });
  const floor = room.floorAtTransform!(new THREE.Matrix4());
  return (x: number, eyeY: number, z: number) => {
    const ray = new THREE.Ray(new THREE.Vector3(x, eyeY, z), new THREE.Vector3(0, -1, 0));
    const hit = floor.intersect(ray);
    if (!hit) return;
    const y = floor.supportHeight(x, hit.y, z, crate);
    if (y === undefined) return { hit: hit.y };
    const transform = { ...pose, position: [x, y, z] as const };
    const body = { id: "crate", bounds: crate, transform };
    const released = resolveObjectPlacement(body, transform, [room], "release");
    return { hit: hit.y, base: released?.position[1] };
  };
}

it("uses the visible slope and its uphill edge when a floor is pitched inside the model", () => {
  const mesh = slab(0.1);
  const pitch = THREE.MathUtils.degToRad(5);
  mesh.rotation.x = pitch;
  const placed = roomPlacement(mesh)(0, 1.7, -1.5);
  const topAt = (z: number) => mesh.position.y + 0.05 / Math.cos(pitch) - z * Math.tan(pitch);
  expect(placed?.hit).toBeCloseTo(topAt(-1.5), 5);
  expect(placed?.base).toBeCloseTo(topAt(-2), 5);
});

it("selects and supports the floor on the camera's storey beneath a mezzanine", () => {
  const place = roomPlacement(slab(0.1), slab(2.5));
  const lower = place(0, 1.7, 0);
  expect(lower?.hit).toBeCloseTo(0.1);
  expect(lower?.base).toBeCloseTo(0.1);
  const upper = place(0, 3.5, 0);
  expect(upper?.hit).toBeCloseTo(2.5);
  expect(upper?.base).toBeCloseTo(2.5);
});

it("seats the entire crate above a narrow raised strip that misses its centre and corners", () => {
  const strip = slab(0.3, 0.18);
  strip.name = "raised-strip";
  strip.position.x = 0.27;
  const place = roomPlacement(slab(0.1), strip);
  const overlapping = place(0, 1.7, 0);
  expect(overlapping?.hit).toBeCloseTo(0.1);
  expect(overlapping?.base).toBeCloseTo(0.3);
  expect(place(1, 1.7, 0)?.base).toBeCloseTo(0.1);
});
