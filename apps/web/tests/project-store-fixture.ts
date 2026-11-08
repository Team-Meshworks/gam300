import { createDocumentStore } from "../editor/document-store";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import fixture from "../shared/project/fixtures/m1-project.json";

export const testRoom: CatalogueAsset = {
  id: "test-room-v1",
  name: "Room",
  kind: "environment",
  url: "room.glb",
  sha256: "0".repeat(64),
  thumbnail: null,
};

export function createLoadedStore(assets: readonly CatalogueAsset[], environmentAssetId: string) {
  const store = createDocumentStore(assets);
  const project = {
    ...fixture,
    scenes: [{ ...fixture.scenes[0], environmentAssetId, objects: [] }],
  };
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const loaded = store.loadProject(JSON.stringify(project), kinds);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return store;
}
