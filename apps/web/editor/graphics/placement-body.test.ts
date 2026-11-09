import { expect, it } from "vitest";
import * as THREE from "three";
import { placementBody } from "./placement-body";
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
