import { assert, it } from "vitest";
import type { CatalogueAsset } from "../shared/assets/catalogue";
import { createDocumentStore } from "./document-store.ts";

it("preserves mixed-asset placement, history branching and earlier snapshots", () => {
  const assets: CatalogueAsset[] = [
    {
      id: "test-room-v1",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      thumbnail: "room.png",
    },
    { id: "test-crate-v1", name: "Crate", kind: "model", url: "crate.glb", thumbnail: "crate.png" },
  ];
  assets.push({
    id: "sample-snowglobe-v1",
    name: "Snow globe",
    kind: "model",
    url: "snowglobe.glb",
    thumbnail: null,
  });
  const store = createDocumentStore(assets);
  let notifications = 0;
  store.subscribe(() => notifications++);
  const initial = store.getSnapshot();
  assert.equal(store.addObject("test-crate-v1", [NaN, 0, 0]).ok, false);
  assert.equal(store.getSnapshot(), initial);
  assert.equal(notifications, 0);

  const first = store.addObject("test-crate-v1", [1, 0, -2]);
  assert.equal(first.ok, true);
  const placed = store.getSnapshot();
  assert.equal(placed.objects.length, 2);
  assert.equal(notifications, 1);
  store.undo();
  assert.equal(store.getSnapshot().objects.length, 0);
  assert.equal(store.getSnapshot().canRedo, true);
  store.redo();
  assert.deepEqual(store.getSnapshot().objects, placed.objects);
  assert.equal(notifications, 3);
  store.undo();
  store.addObject("test-crate-v1", [2, 0, 1]);
  assert.equal(store.getSnapshot().canRedo, false);
  assert.notEqual(store.getSnapshot().objects[0]?.id, placed.objects[0]?.id);
  const branched = store.getSnapshot();
  store.redo();
  assert.equal(store.getSnapshot(), branched);
  assert.equal(placed.objects.length, 1, "Old snapshots remain unchanged");

  const beforeUnknown = store.getSnapshot();
  assert.equal(store.addObject("unknown", [0, 0, 0]).ok, false);
  assert.equal(store.getSnapshot(), beforeUnknown);
  const room = store.addObject("test-room-v1", [0, 0, 0]);
  assert.equal(room.ok, true);
  if (!room.ok) throw new Error(room.error);
  assert.equal(room.object.assetId, "test-room-v1");
  store.undo();
  store.redo();
  assert.equal(store.getSnapshot().objects.at(-1)?.id, room.object.id);
  assert.equal(store.getSnapshot().objects.at(-1)?.assetId, "test-room-v1");

  const globe = store.addObject("sample-snowglobe-v1", [2, 0, 0]);
  assert.equal(globe.ok, true);
  if (!globe.ok) throw new Error(globe.error);
  store.undo();
  store.redo();
  assert.equal(store.getSnapshot().objects.at(-1)?.id, globe.object.id);
  assert.equal(store.getSnapshot().objects.at(-1)?.assetId, "sample-snowglobe-v1");
});

it("commits one reversible transform and rejects invalid moves without changing history", () => {
  const store = createDocumentStore([
    { id: "crate", name: "Crate", kind: "model", url: "crate.glb", thumbnail: null },
  ]);
  const placed = store.addObject("crate", [1, 0, 0]);
  if (!placed.ok) throw new Error(placed.error);
  const original = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => notifications++);
  assert.equal(store.setTransform("missing", placed.object.transform).ok, false);
  assert.equal(
    store.setTransform(placed.object.id, { ...placed.object.transform, position: [Infinity, 0, 0] })
      .ok,
    false,
  );
  assert.deepEqual(store.setTransform(placed.object.id, placed.object.transform), {
    ok: true,
    changed: false,
  });
  assert.equal(store.getSnapshot(), original);
  assert.equal(notifications, 0);

  const moved = store.setTransform(placed.object.id, {
    ...placed.object.transform,
    position: [2, 0, -3],
  });
  assert.deepEqual(moved, { ok: true, changed: true });
  const after = store.getSnapshot();
  assert.deepEqual(after.objects[0]?.transform.position, [2, 0, -3]);
  assert.equal(Object.isFrozen(after.objects[0]?.transform.position), true);
  assert.equal(notifications, 1);
  store.undo();
  assert.deepEqual(store.getSnapshot().objects[0]?.transform.position, [1, 0, 0]);
  store.undo();
  assert.equal(store.getSnapshot().objects.length, 0);
  store.redo();
  store.redo();
  assert.deepEqual(store.getSnapshot().objects[0]?.transform.position, [2, 0, -3]);
  assert.equal(store.getSnapshot().objects[0]?.id, placed.object.id);
  store.undo();
  store.setTransform(placed.object.id, { ...placed.object.transform, position: [4, 0, 0] });
  assert.equal(store.getSnapshot().canRedo, false);
  assert.deepEqual(original.objects[0]?.transform.position, [1, 0, 0]);
});

it("creates a saveable room project while preserving model IDs, transforms and history", () => {
  const assets: CatalogueAsset[] = [
    { id: "test-room-v1", name: "Room", kind: "environment", url: "room.glb", thumbnail: null },
    { id: "test-crate-v1", name: "Crate", kind: "model", url: "crate.glb", thumbnail: null },
  ];
  const store = createDocumentStore(assets);
  store.addObject("test-crate-v1", [2, 0, -3]);
  const before = store.getSnapshot();
  assert.equal(store.createProject("test-crate-v1").ok, false);
  assert.equal(store.getSnapshot(), before);
  const created = store.createProject("test-room-v1");
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.error.message);
  assert.deepEqual(created.value.scenes[0]?.objects, before.objects);
  assert.equal(created.value.scenes[0]?.environmentAssetId, "test-room-v1");
  store.undo();
  assert.equal(store.getSnapshot().project?.scenes[0]?.objects.length, 0);
  store.redo();
  assert.deepEqual(store.getSnapshot().objects, before.objects);
  const reopened = createDocumentStore(assets);
  assert.equal(
    reopened.loadProject(
      JSON.stringify(store.getSnapshot().project),
      new Map(assets.map((a) => [a.id, a.kind])),
    ).ok,
    true,
  );
  assert.deepEqual(reopened.getSnapshot().project, store.getSnapshot().project);
  assert.equal(store.createProject("test-room-v1").ok, false);
  const empty = createDocumentStore(assets).createProject("test-room-v1");
  assert.equal(empty.ok, true);
  if (!empty.ok) throw new Error(empty.error.message);
  assert.equal(empty.value.scenes[0]?.objects.length, 0);
  assert.notEqual(empty.value.projectId, created.value.projectId);
});
