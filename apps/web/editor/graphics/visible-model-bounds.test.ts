import { expect, it } from "vitest";
import * as THREE from "three";
import { visibleModelBounds } from "./visible-model-bounds";

it("fits visible case geometry while excluding hidden covers and their descendants", () => {
  const root = new THREE.Group();
  root.position.set(3, 0, 2);
  const caseBody = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2));
  caseBody.position.y = 0.5;
  root.add(caseBody);
  const cover = new THREE.Group();
  cover.add(new THREE.Mesh(new THREE.BoxGeometry(10, 20, 10)));
  cover.visible = false;
  root.add(cover);
  root.add(new THREE.Sprite());
  const box = visibleModelBounds(root);
  expect(box.min.toArray()).toEqual([2, 0, 1]);
  expect(box.max.toArray()).toEqual([4, 1, 3]);
  cover.visible = true;
  expect(visibleModelBounds(root).getSize(new THREE.Vector3()).y).toBe(20);
});
