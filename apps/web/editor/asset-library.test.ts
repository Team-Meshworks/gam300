import { describe, expect, it } from "vitest";
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
  return { store };
}
// Exercise storage directly so picker state cannot hide a failed or partial placement
// Each case checks that replacement and removal keep IDs and undo history intact
describe("display-case store commands", () => {
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
