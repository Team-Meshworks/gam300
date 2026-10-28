import { describe, expect, it } from "vitest";
import { createAssetLibrary } from "./asset-library";
import { createDocumentStore } from "./document-store";
import type { CatalogueAsset } from "../shared/assets/catalogue";
const assets: CatalogueAsset[] = [
  {
    id: "room",
    name: "Room",
    kind: "environment",
    url: "/room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "vase",
    name: "Blue Vase",
    kind: "model",
    url: "/vase.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];
function setup() {
  const store = createDocumentStore(assets);
  store.createProject("room");
  return { store, library: createAssetLibrary(assets, store) };
}
// Exercise storage directly so picker state cannot hide a failed or partial placement
// Each case checks that replacement and removal keep IDs and undo history intact
describe("asset library and display-case commands", () => {
  it("searches approved models, closes on choice and places through the existing undo command", () => {
    const { store, library } = setup();
    const before = store.getSnapshot();
    library.open();
    library.search(" BLUE ");
    expect(library.getSnapshot().results.map((asset) => asset.id)).toEqual(["vase"]);
    expect(library.choose("vase").ok).toBe(true);
    expect(library.getSnapshot().mode).toBe("placing");
    expect(store.getSnapshot()).toBe(before);
    expect(library.place([2, 0, 3]).ok).toBe(true);
    const object = store.getSnapshot().objects[0]!;
    expect(object.transform.position).toEqual([2, 0, 3]);
    expect(library.getSnapshot().mode).toBe("closed");
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.redo();
    expect(store.getSnapshot().objects[0]!.id).toBe(object.id);
    expect(library.place([1, 0, 1]).ok).toBe(false);
  });
  it("rejects unknown, environment and hidden results without changing the document", () => {
    const { store, library } = setup();
    const before = store.getSnapshot();
    library.open();
    expect(library.choose("missing").ok).toBe(false);
    expect(library.choose("room").ok).toBe(false);
    library.search("nothing");
    expect(library.choose("vase").ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
  it("cancels without history and keeps invalid placement retryable", () => {
    const { store, library } = setup();
    const before = store.getSnapshot();
    library.open();
    library.choose("vase");
    expect(library.place([NaN, 0, 0]).ok).toBe(false);
    expect(library.place([10001, 0, 0]).ok).toBe(false);
    expect(library.getSnapshot().mode).toBe("placing");
    library.cancel();
    expect(store.getSnapshot()).toBe(before);
  });
  it("discards a stale pick after project replacement", () => {
    const { store, library } = setup();
    library.open();
    library.choose("vase");
    store.resetProject();
    store.createProject("room");
    expect(library.place([0, 0, 0]).ok).toBe(false);
    expect(store.getSnapshot().objects).toHaveLength(0);
    expect(library.getSnapshot().mode).toBe("closed");
  });

  it("rotates and uniformly resizes nested attachments and rejects distortion without changing history", () => {
    const { store } = setup();
    const root = store.addObject("vase", [0, 0, 0]);
    if (!root.ok) throw new Error(root.error);
    const child = store.addAttachedObject("vase", root.object.id, [1, 1, 0]);
    if (!child.ok) throw new Error(child.error);
    const nested = store.addAttachedObject("vase", child.object.id, [1, 2, 0]);
    expect(nested.ok).toBe(true);
    const rotated = {
      position: [0, 0, 0],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      scale: [2, 2, 2],
    };
    expect(store.setTransform(root.object.id, rotated).ok).toBe(true);
    const position = store.getSnapshot().objects[2]!.transform.position;
    expect(position[0]).toBeCloseTo(0);
    expect(position[1]).toBeCloseTo(4);
    expect(position[2]).toBeCloseTo(-2);
    const before = store.getSnapshot();
    expect(store.setTransform(root.object.id, { ...rotated, scale: [2, 3, 2] }).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.deleteObject(root.object.id).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
  it("replaces one slot and restores removal without losing the display case", () => {
    const store = createDocumentStore([...assets, { ...assets[1]!, id: "crate", name: "Crate" }]);
    store.createProject("room");
    const placed = store.addObject("vase", [0, 0, 0]);
    if (!placed.ok) throw new Error(placed.error);
    const id = placed.object.id;
    const first = store.addAttachedObject("vase", id, [0, 1, 0]);
    if (!first.ok) throw new Error(first.error);
    expect(store.addAttachedObject("crate", id, [0, 2, 0]).ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(2);
    expect(store.getSnapshot().objects[1]).toMatchObject({
      id: first.object.id,
      assetId: "crate",
      transform: first.object.transform,
    });
    store.undo();
    expect(store.getSnapshot().objects[1]).toEqual(first.object);
    store.redo();
    expect(store.removeDisplayedAsset(id).ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([id]);
    store.undo();
    expect(store.getSnapshot().objects[1]!.id).toBe(first.object.id);
    const before = store.getSnapshot();
    expect(store.addAttachedObject("missing", id, [0, 1, 0]).ok).toBe(false);
    expect(store.addAttachedObject("vase", "missing", [0, 1, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
});
