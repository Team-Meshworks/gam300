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
      sha256: "0".repeat(64),
      thumbnail: "room.png",
    },
    {
      id: "test-crate-v1",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: "crate.png",
    },
  ];
  assets.push({
    id: "sample-snowglobe-v1",
    name: "Snow globe",
    kind: "model",
    url: "snowglobe.glb",
    sha256: "0".repeat(64),
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
  assert.equal(placed.objects.length, 1);
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
    {
      id: "crate",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
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

it("shares one undo order across incoming gizmo moves, edit sessions and deletion", () => {
  const store = createDocumentStore([
    {
      id: "crate",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
  ]);
  const added = store.addObject("crate", [0, 0, 0]);
  if (!added.ok) throw new Error(added.error);
  const started = store.beginTransform(added.object.id);
  if (!started.ok) throw new Error(started.error.message);
  store.previewTransform(started.value.token, { ...added.object.transform, position: [9, 0, 0] });
  assert.deepEqual(
    store.setTransform(added.object.id, { ...added.object.transform, position: [3, 0, 0] }),
    { ok: true, changed: true },
  );
  assert.equal(store.getTransformEdit(), null);
  assert.equal(store.commitTransformEdit(started.value.token).ok, false);
  store.deleteObject(added.object.id);
  store.undo();
  assert.deepEqual(store.getSnapshot().objects[0]?.transform.position, [3, 0, 0]);
  store.undo();
  assert.deepEqual(store.getSnapshot().objects[0]?.transform.position, [0, 0, 0]);
  store.undo();
  assert.equal(store.getSnapshot().objects.length, 0);
  store.redo();
  store.redo();
  store.redo();
  assert.equal(store.getSnapshot().objects.length, 0);
});

it("stores interactions in the project and reloads them with the scene", () => {
  const assets: CatalogueAsset[] = [
    {
      id: "test-room-v1",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
    {
      id: "test-crate-v1",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
  ];
  const store = createDocumentStore(assets);
  assert.equal(store.setInteractions([]).ok, false);
  const placed = store.addObject("test-crate-v1", [1, 0, 0]);
  if (!placed.ok) throw new Error(placed.error);
  assert.equal(store.createProject("test-room-v1").ok, true);
  const hotspot = store.addHotspot(placed.object.id);
  if (!hotspot.ok) throw new Error(hotspot.error.message);

  const interactions = [
    { when: { type: "scene-starts" as const }, do: { type: "print-hi" as const } },
    {
      when: { type: "visitor-clicks-hotspot" as const, targetHotspotId: hotspot.value.id },
      do: { type: "open-link" as const, url: "https://example.com" },
    },
  ];
  const saved = store.setInteractions(interactions);
  assert.equal(saved.ok, true);
  const scene = store.getSnapshot().project?.scenes[0];
  assert.deepEqual(scene?.interactions, interactions);
  assert.equal(Object.isFrozen(scene?.interactions), true);
  assert.equal(Object.isFrozen(scene?.interactions[0]), true);
  assert.equal(Object.isFrozen(scene?.interactions[0]?.when), true);

  const reopened = createDocumentStore(assets);
  const loaded = reopened.loadProject(
    JSON.stringify(store.getSnapshot().project),
    new Map(assets.map((asset) => [asset.id, asset.kind])),
  );
  assert.equal(loaded.ok, true);
  assert.deepEqual(reopened.getSnapshot().objects, store.getSnapshot().objects);
  assert.deepEqual(reopened.getSnapshot().project?.scenes[0]?.interactions, interactions);
});

it("creates a saveable room project while preserving model IDs, transforms and history", () => {
  const assets: CatalogueAsset[] = [
    {
      id: "test-room-v1",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
    {
      id: "test-crate-v1",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
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

it("attaches hotspots to objects and removes their rules with the object", () => {
  const assets: CatalogueAsset[] = [
    {
      id: "test-room-v1",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
    {
      id: "test-crate-v1",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
  ];
  const store = createDocumentStore(assets);
  const object = store.addObject("test-crate-v1", [1, 0, 0]);
  if (!object.ok) throw new Error(object.error);
  assert.equal(store.addHotspot(object.object.id).ok, false);
  assert.equal(store.createProject("test-room-v1").ok, true);

  assert.equal(store.addHotspot(object.object.id, [NaN, 0, 0]).ok, false);
  const added = store.addHotspot(object.object.id, [0.25, 0, -0.5]);
  if (!added.ok) throw new Error(added.error.message);
  assert.deepEqual(added.value.position, [0.25, 0, -0.5]);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.hotspots, [added.value]);

  const unrelated = {
    when: { type: "scene-starts" as const },
    do: { type: "print-hi" as const },
  };
  assert.equal(
    store.setInteractions([
      unrelated,
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: "missing" },
        do: { type: "print-hi" },
      },
    ]).ok,
    false,
  );
  const click = {
    when: { type: "visitor-clicks-hotspot" as const, targetHotspotId: added.value.id },
    do: { type: "print-hi" as const },
  };
  assert.equal(store.setInteractions([unrelated, click]).ok, true);

  assert.equal(store.deleteObject(object.object.id).ok, true);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.hotspots, []);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.interactions, [unrelated]);
  store.undo();
  assert.equal(store.getSnapshot().objects.length, 1);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.hotspots, []);
});

it("deleting a hotspot keeps unrelated interactions", () => {
  const assets: CatalogueAsset[] = [
    {
      id: "test-room-v1",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
    {
      id: "test-crate-v1",
      name: "Crate",
      kind: "model",
      url: "crate.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
  ];
  const store = createDocumentStore(assets);
  const object = store.addObject("test-crate-v1", [0, 0, 0]);
  if (!object.ok) throw new Error(object.error);
  assert.equal(store.createProject("test-room-v1").ok, true);
  const hotspot = store.addHotspot(object.object.id);
  if (!hotspot.ok) throw new Error(hotspot.error.message);
  const sceneStart = {
    when: { type: "scene-starts" as const },
    do: { type: "print-hi" as const },
  };
  assert.equal(
    store.setInteractions([
      sceneStart,
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspot.value.id },
        do: { type: "print-hi" },
      },
    ]).ok,
    true,
  );

  assert.equal(store.deleteHotspot(hotspot.value.id).ok, true);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.hotspots, []);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.interactions, [sceneStart]);
  assert.equal(store.deleteHotspot(hotspot.value.id).ok, false);
});
