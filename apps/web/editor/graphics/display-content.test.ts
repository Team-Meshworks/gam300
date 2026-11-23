import { expect, it } from "vitest";
import * as THREE from "three";
import { createDisplayContent } from "./display-content";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { ContentObject } from "../../shared/project/project-content";

it("preserves saved legacy text without rendering it on an ordinary model", () => {
  const asset = {
    id: "sculpture",
    name: "Sculpture",
    kind: "model",
    url: "object.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  } satisfies CatalogueAsset;
  const material = new THREE.MeshBasicMaterial();
  const model = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const owner = new THREE.Group();
  owner.add(model);
  const display = createDisplayContent([asset], () => {});
  const text: ContentObject = {
    id: "object",
    assetId: asset.id,
    name: "Ordinary model",
    parentId: null,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [
      {
        id: "caption",
        type: "text",
        runs: [{ text: "Saved legacy text", marks: [] }],
        caption: "",
      },
    ],
  };
  display.sync([text], new Map([[text.id, owner]]));
  try {
    expect(owner.children).toEqual([model]);
    expect(text.components[0]).toMatchObject({
      id: "caption",
      runs: [{ text: "Saved legacy text" }],
    });
  } finally {
    display.dispose();
    model.geometry.dispose();
    material.dispose();
  }
});
