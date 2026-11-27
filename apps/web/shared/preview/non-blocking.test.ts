import { expect, it } from "vitest";
import * as THREE from "three";
import { addNonBlockingHitbox, disableMeshRaycast, NON_BLOCKING_HITBOX_NAME } from "./non-blocking";

it("stops model meshes from being picked while leaving sibling hotspot sprites pickable", () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  root.add(mesh);
  const sprite = new THREE.Sprite();
  sprite.position.z = 2;
  root.add(sprite);
  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
  ray.camera = new THREE.PerspectiveCamera();
  expect(ray.intersectObject(root, true).length).toBeGreaterThan(0);
  disableMeshRaycast(root);
  const hits = ray.intersectObject(root, true);
  expect(hits.some((hit) => hit.object === mesh)).toBe(false);
  expect(hits.some((hit) => hit.object === sprite)).toBe(true);
});

it("adds a hidden pickable hitbox matching the model bounds", () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
  mesh.position.y = 1;
  root.add(mesh);

  addNonBlockingHitbox(root);

  const hitbox = root.getObjectByName(NON_BLOCKING_HITBOX_NAME);
  expect(hitbox).toBeInstanceOf(THREE.Mesh);
  const box = hitbox as THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  expect(box.geometry.parameters).toMatchObject({ width: 1, height: 2, depth: 1 });
  expect(box.position.toArray()).toEqual([0, 1, 0]);
  expect(box.material.visible).toBe(false);

  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 0, -1));
  ray.camera = new THREE.PerspectiveCamera();
  const hits = ray.intersectObject(root, true);
  expect(hits.some((hit) => hit.object === mesh)).toBe(false);
  expect(hits.some((hit) => hit.object === hitbox)).toBe(true);
});

it("does not add a second hitbox when configured twice", () => {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));

  addNonBlockingHitbox(root);
  addNonBlockingHitbox(root);

  expect(root.children.filter((node) => node.name === NON_BLOCKING_HITBOX_NAME)).toHaveLength(1);
});
