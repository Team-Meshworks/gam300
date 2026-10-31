import { describe, expect, it } from "vitest";
import { searchAssets, type CatalogueAsset } from "./catalogue";
import { createDocumentStore } from "../../editor/document-store";

const assets: readonly CatalogueAsset[] = Object.freeze([
  Object.freeze({
    id: "chair",
    name: "Blue Chair",
    kind: "model",
    url: "/chair.glb",
    sha256: "",
    thumbnail: null,
  }),
  Object.freeze({
    id: "panel",
    name: "Blue Panel",
    kind: "model",
    url: "/panel.glb",
    sha256: "",
    thumbnail: null,
  }),
  Object.freeze({
    id: "room",
    name: "Gallery",
    kind: "environment",
    url: "/room.glb",
    sha256: "",
    thumbnail: null,
  }),
]);

describe("catalogue search", () => {
  it("matches case-insensitive trimmed asset names", () => {
    expect(searchAssets(assets, "  bLuE  ")).toEqual([assets[0], assets[1]]);
    expect(searchAssets(assets, "panel")).toEqual([assets[1]]);
    expect(searchAssets(assets, "gallery")).toEqual([assets[2]]);
  });

  it("clears to the original order and references without changing the catalogue", () => {
    expect(searchAssets(assets, "chair")[0]).toBe(assets[0]);
    expect(searchAssets(assets, "  ")).toEqual(assets);
    expect(assets.map((asset) => asset.id)).toEqual(["chair", "panel", "room"]);
  });

  it("treats patterns, markup as literal input", () => {
    for (const query of [".*", "[", "<script>", "' OR 1=1 --"]) {
      expect(searchAssets(assets, query)).toEqual([]);
    }
  });

  it("places a search result through existing history and preserves its ID on redo", () => {
    const store = createDocumentStore(assets);
    const match = searchAssets(assets, "BLUE")[0];
    expect(match).toBeDefined();
    const result = store.addObject(match!.id, [1, 0, -2]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const placed = store.getSnapshot();
    expect(placed.objects).toHaveLength(1);
    expect(result.object.assetId).toBe("chair");
    expect(result.object.transform.position).toEqual([1, 0, -2]);

    searchAssets(assets, "nothing");
    searchAssets(assets, "");
    expect(store.getSnapshot()).toBe(placed);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.redo();
    expect(store.getSnapshot().objects[0]?.id).toBe(result.object.id);
  });
});
