import { expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import { serializeProject } from "../shared/project/project-serialization";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";

const assets: CatalogueAsset[] = [
  {
    id: "room",
    name: "Room",
    kind: "environment",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
    room: { width: 10, depth: 10 },
  },
  {
    id: "module",
    name: "Room",
    kind: "model",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
    room: { width: 10, depth: 10, environmentAssetId: "room" },
  },
];

it("creates the first room as a selected-ready movable object on the floor", () => {
  const store = createDocumentStore(assets);
  const created = store.createProject("room", {
    startEmpty: true,
    movableRoom: true,
    position: [3.2, 9, -4.1],
  });
  expect(created.ok).toBe(true);
  expect(store.getSnapshot().project?.schemaVersion).toBe(2);
  expect(store.getSnapshot().project?.scenes[0]?.environmentAssetId).toBeNull();
  const first = store.getSnapshot().objects[0]!;
  expect(first.assetId).toBe("module");
  expect(first.transform.position).toEqual([3, 0, -4]);
  expect(store.setTransform(first.id, { ...first.transform, position: [8, 5, 2] }).ok).toBe(true);
  expect(store.getSnapshot().objects[0]!.transform.position).toEqual([8, 0, 2]);
  store.undo();
  expect(store.getSnapshot().objects[0]).toEqual(first);
  const kinds = new Map(assets.map((a) => [a.id, a.kind]));
  const encoded = serializeProject(store.getSnapshot().project, kinds);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) throw new Error("serialization failed");
  const restored = createDocumentStore(assets);
  expect(restored.loadProject(encoded.value, kinds, store.getRecoveryHistory()).ok).toBe(true);
  expect(restored.getSnapshot().objects[0]).toEqual(first);
});

it("converts a legacy fixed room once without losing objects or earlier undo history", () => {
  const store = createDocumentStore(assets);
  store.createProject("room");
  store.addRoom("room");
  const before = store.getSnapshot().project;
  const result = store.makeRoomMovable();
  expect(result.ok).toBe(true);
  expect(store.getSnapshot().project?.scenes[0]?.environmentAssetId).toBeNull();
  expect(store.getSnapshot().objects).toHaveLength(2);
  expect(store.makeRoomMovable().ok).toBe(false);
  store.undo();
  expect(store.getSnapshot().project).toEqual(before);
  store.undo();
  expect(store.getSnapshot().objects).toHaveLength(0);
  store.redo();
  store.redo();
  expect(store.getSnapshot().objects).toHaveLength(2);
});

it("adds adjacent rooms with independent IDs and preserves layout through undo, recovery and JSON", () => {
  const store = createDocumentStore(assets);
  expect(store.createProject("room").ok).toBe(true);
  const a = store.addRoom("room"),
    b = store.addRoom("room");
  expect(a.ok && b.ok).toBe(true);
  expect(store.getSnapshot().objects).toHaveLength(2);
  expect(new Set(store.getSnapshot().objects.map((o) => o.id)).size).toBe(2);
  const original = store.getSnapshot().project!;
  store.undo();
  expect(store.getSnapshot().objects).toHaveLength(1);
  store.redo();
  expect(store.getSnapshot().project).toEqual(original);
  const restored = createDocumentStore(assets);
  const kinds = new Map(assets.map((a) => [a.id, a.kind]));
  const serialized = serializeProject(original, kinds);
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) throw new Error("serialization failed");
  expect(restored.loadProject(serialized.value, kinds, store.getRecoveryHistory()).ok).toBe(true);
  expect(restored.getSnapshot().objects).toEqual(store.getSnapshot().objects);
  restored.undo();
  expect(restored.getSnapshot().objects).toHaveLength(1);
});

it("snaps edits, refuses overlap/tilting/scaling, and duplicates into free floor space", () => {
  const store = createDocumentStore(assets);
  store.createProject("room");
  const added = store.addRoom("room", [9.4, 12, 0.2]);
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error("placement failed");
  expect(added.object.transform.position).toEqual([10, 0, 0]);
  expect(
    store.setTransform(added.object.id, { ...added.object.transform, position: [0, 0, 0] }).ok,
  ).toBe(false);
  expect(
    store.setTransform(added.object.id, { ...added.object.transform, scale: [2, 2, 2] }).ok,
  ).toBe(false);
  expect(
    store.setTransform(added.object.id, { ...added.object.transform, rotation: [0, 1, 0, 0] }).ok,
  ).toBe(false);
  expect(
    store.setTransform(added.object.id, { ...added.object.transform, position: [19.8, 5, 0.2] }).ok,
  ).toBe(true);
  expect(store.getSnapshot().objects[0]!.transform.position).toEqual([20, 0, 0]);
  expect(store.duplicateObject(added.object.id).ok).toBe(true);
  expect(store.getSnapshot().objects[1]!.transform.position).not.toEqual([20, 0, 0]);
  expect(store.getSnapshot().objects[1]!.transform.position[1]).toBe(0);
  store.undo();
  expect(store.getSnapshot().objects).toHaveLength(1);
});

it("starts new scenes with independent movable rooms and restores them through undo", () => {
  const store = createDocumentStore(assets);
  expect(store.createScene("First").ok).toBe(true);
  const first = store.getSnapshot().objects[0]!;
  expect(first.assetId).toBe("module");
  expect(store.getSnapshot().project?.scenes[0]?.environmentAssetId).toBeNull();
  expect(store.createScene("Second").ok).toBe(true);
  const second = store.getSnapshot().objects[0]!;
  expect(second.id).not.toBe(first.id);
  expect(second.transform.position).toEqual([0, 0, 0]);
  expect(store.getSnapshot().project?.scenes[1]?.environmentAssetId).toBeNull();
  store.undo();
  expect(store.getSnapshot().objects).toEqual([first]);
  store.redo();
  expect(store.getSnapshot().objects).toEqual([second]);
});
