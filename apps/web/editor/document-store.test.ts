import { serializeProject } from "../shared/project/project-serialization";
import { deserializeProject } from "../shared/project/project-deserialization";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { createDocumentStore } from "./document-store.ts";

afterEach(() => vi.restoreAllMocks());

it("places a different sized room beside the starter and preserves it through save and reopen", () => {
  const assets: CatalogueAsset[] = [
    {
      id: "test-room-v1",
      name: "Starter",
      kind: "environment",
      url: "starter.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
    {
      id: "room-space1-module-v1",
      name: "Space1",
      kind: "model",
      url: "space.glb",
      sha256: "1".repeat(64),
      thumbnail: null,
      placement: "bottom-center",
      boundsMeters: { min: [-4, 0, -3], max: [4, 3, 3] },
    },
  ];
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const store = createDocumentStore(assets);
  expect(store.createProject("test-room-v1").ok).toBe(true);
  const added = store.addObject("room-space1-module-v1", [8, 0, 1]);
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(added.error);
  expect(added.object.transform.position).toEqual([9, 0, 0]);
  const saved = serializeProject(store.getSnapshot().project!, kinds);
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.message);
  const reopened = createDocumentStore(assets);
  expect(reopened.loadProject(saved.value, kinds).ok).toBe(true);
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([9, 0, 0]);
  const room = reopened.getSnapshot().objects[0]!;
  expect(reopened.setTransform(room.id, { ...room.transform, position: [0, 0, 7] }).ok).toBe(true);
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 8]);
  reopened.undo();
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([9, 0, 0]);
  reopened.redo();
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 8]);
  const moved = reopened.getSnapshot().objects[0]!;
  expect(
    reopened.setTransform(moved.id, {
      ...moved.transform,
      position: [0, 0, 9],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    }).ok,
  ).toBe(true);
  expect(reopened.getSnapshot().objects[0]!.transform.position[2]).toBeCloseTo(9);
});

it("rejects moving a single large room outside the visible grid", () => {
  const room: CatalogueAsset = {
    id: "room-space1-v1",
    name: "Space1",
    kind: "environment",
    url: "room.glb",
    sha256: "1".repeat(64),
    thumbnail: null,
    boundsMeters: { min: [-10, 0, -8], max: [10, 4, 8] },
  };
  const store = createDocumentStore([room]);
  expect(store.createProject(room.id).ok).toBe(true);
  const before = store.getSnapshot();
  const sceneId = before.activeSceneId!;
  expect(
    store.setSelectionTransform([sceneId], sceneId, {
      position: [31, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }).ok,
  ).toBe(false);
  expect(store.getSnapshot()).toBe(before);
});

it("preserves whole-room variants, exhibits and transforms through replacement, undo and reload", () => {
  const assets: CatalogueAsset[] = ["room-space1-v1", "room-doors-1-v1", "test-crate-v1"].map(
    (id) => ({
      id,
      name: id,
      kind: id === "test-crate-v1" ? "model" : "environment",
      url: `${id}.glb`,
      sha256: "0".repeat(64),
      thumbnail: null,
      ...(id.startsWith("room-")
        ? {
            placement: "bottom-center" as const,
            boundsMeters: { min: [7, 0, -57] as const, max: [37, 4, -33] as const },
          }
        : {}),
    }),
  );
  const store = createDocumentStore(assets);
  assert.equal(store.createProject("room-space1-v1").ok, true);
  assert.deepEqual(store.getSnapshot().project!.scenes[0]!.startCamera.position, [36, 48, 54]);
  const id = store.getSnapshot().activeSceneId!;
  const crate = store.addObject("test-crate-v1", [1, 0, 2]);
  if (!crate.ok) throw Error(crate.error);
  assert.equal(
    store.setSelectionTransform([id], id, {
      position: [3, 0, 4],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }).ok,
    true,
  );
  const before = store.getSnapshot().project!;
  assert.deepEqual(before.scenes[0]!.objects[0]!.transform.position, [4, 0, 6]);
  assert.equal(
    store.setSelectionTransform([id], id, {
      position: [3, 0, 4],
      rotation: [0, 0, 0, 1],
      scale: [2, 2, 2],
    }).ok,
    false,
  );
  assert.equal(store.setEnvironment("room-doors-1-v1").ok, true);
  const changed = store.getSnapshot().project!;
  assert.deepEqual(changed.scenes[0]!.objects, before.scenes[0]!.objects);
  assert.deepEqual(changed.scenes[0]!.environmentTransform, before.scenes[0]!.environmentTransform);
  store.undo();
  assert.equal(store.getSnapshot().project!.scenes[0]!.environmentAssetId, "room-space1-v1");
  store.redo();
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const saved = serializeProject(store.getSnapshot().project!, kinds);
  if (!saved.ok) throw Error(saved.error.message);
  const restored = createDocumentStore(assets);
  assert.equal(restored.loadProject(saved.value, kinds).ok, true);
  assert.deepEqual(restored.getSnapshot().project, changed);
  assert.equal(store.deleteObject(id).ok, true);
  assert.equal(store.getSnapshot().project!.scenes[0]!.environmentVisible, false);
  assert.equal(store.setEnvironment("room-space1-v1").ok, true);
  assert.equal(store.getSnapshot().project!.scenes[0]!.environmentVisible, true);
});

it.each([
  [0, "00000000-0000-7cc3-98c4-dc0c0c07398f"],
  // RFC 9562 Appendix A.6 test vector
  [1645557742000, "017f22e2-79b0-7cc3-98c4-dc0c0c07398f"],
  [0xffffffffffff, "ffffffff-ffff-7cc3-98c4-dc0c0c07398f"],
])("creates a UUIDv7 project ID at %i milliseconds", (timestamp, expected) => {
  vi.spyOn(Date, "now").mockReturnValue(timestamp);
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("aaaaaaaa-bbbb-4cc3-98c4-dc0c0c07398f");
  const store = createDocumentStore([
    {
      id: "room",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
  ]);
  const created = store.createProject("room");
  if (!created.ok) throw new Error(created.error.message);
  assert.equal(created.value.projectId, expected);
});

it("uses UUIDv7 when the Scenes panel creates the first project, retaining UUIDv4 scene IDs", () => {
  vi.spyOn(Date, "now").mockReturnValue(1645557742000);
  const store = createDocumentStore([
    {
      id: "room",
      name: "Room",
      kind: "environment",
      url: "room.glb",
      sha256: "0".repeat(64),
      thumbnail: null,
    },
  ]);
  assert.equal(store.createScene("First scene", "room").ok, true);
  const project = store.getSnapshot().project!;
  assert.match(project.projectId, /^017f22e2-79b0-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(project.scenes[0]!.id[14], "4");
  assert.equal(store.createScene("Second scene", "room").ok, true);
  store.undo();
  assert.equal(store.getSnapshot().project!.projectId, project.projectId);
  store.redo();
  assert.equal(store.getSnapshot().project!.projectId, project.projectId);
});

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

  assert.equal(
    store.setInteractions([
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspot.value.id },
        do: { type: "open-link", url: "https://[" },
      },
    ]).ok,
    true,
  );
  assert.equal(
    reopened.loadProject(
      JSON.stringify(store.getSnapshot().project),
      new Map(assets.map((asset) => [asset.id, asset.kind])),
    ).ok,
    false,
  );
});

it("creates a saveable room project while preserving model IDs, transforms and history", () => {
  vi.spyOn(Date, "now").mockReturnValue(1645557742000);
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
  assert.match(
    created.value.projectId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(created.value.scenes[0]?.id[14], "4");
  assert.equal(created.value.scenes[0]?.objects[0]?.id[14], "4");
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

  const duplicate = store.addHotspot(object.object.id.toUpperCase(), [0, 0, 0]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.error.message, "Each object can have at most one hotspot");
  }

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
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.hotspots, [added.value]);
  assert.deepEqual(store.getSnapshot().project?.scenes[0]?.interactions, [unrelated, click]);
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

it("snaps a module beside an approved Starter room and keeps its server identity", () => {
  const hash = "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1";
  const approvedId = "22222222-2222-4222-8222-222222222222";
  const assets: CatalogueAsset[] = [
    {
      id: approvedId,
      name: "Starter room",
      kind: "environment",
      url: "room.glb",
      sha256: hash.toUpperCase(),
      thumbnail: null,
    },
    {
      id: "test-room-module-v1",
      name: "Starter room",
      kind: "model",
      url: "room.glb",
      sha256: hash,
      thumbnail: null,
    },
  ];
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const store = createDocumentStore(assets);
  expect(store.createProject(approvedId).ok).toBe(true);
  const added = store.addObject("test-room-module-v1", [7.46, 0, -5.35]);
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(added.error);
  expect(added.object.transform.position).toEqual([10, 0, 0]);
  expect(added.object.name).toBe("Starter room 2");
  expect(store.getSnapshot().project!.scenes[0]!.environmentAssetId).toBe(approvedId);
  const saved = serializeProject(store.getSnapshot().project!, kinds);
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.message);
  store.undo();
  expect(store.getSnapshot().objects).toHaveLength(0);
  store.redo();
  expect(store.getSnapshot().objects[0]!.transform.position).toEqual([10, 0, 0]);
  const reopened = createDocumentStore(assets);
  expect(reopened.loadProject(saved.value, kinds).ok).toBe(true);
  expect(reopened.getSnapshot().project!.scenes[0]!.environmentAssetId).toBe(approvedId);
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([10, 0, 0]);
  const older = JSON.parse(saved.value);
  older.scenes[0].objects[0].transform.position = [7.46, 0, -5.35];
  expect(reopened.loadProject(JSON.stringify(older), kinds).ok).toBe(true);
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([7.46, 0, -5.35]);

  const sceneId = store.getSnapshot().activeSceneId!;
  expect(
    store.setSelectionTransform([sceneId, added.object.id], sceneId, {
      position: [2, 0, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }).ok,
  ).toBe(true);
  expect(store.getSnapshot().project!.scenes[0]!.environmentAssetId).toBe(approvedId);
  expect(store.getSnapshot().objects[0]!.transform.position).toEqual([12, 0, 3]);

  const hidden = createDocumentStore(assets);
  expect(hidden.createProject(approvedId).ok).toBe(true);
  expect(hidden.deleteObject(hidden.getSnapshot().activeSceneId!).ok).toBe(true);
  const alone = hidden.addObject("test-room-module-v1", [7.46, 0, -5.35]);
  expect(alone.ok).toBe(true);
  if (alone.ok) expect(alone.object.transform.position).toEqual([7.46, 0, -5.35]);
});

it("reconnects an approved Starter room and its module when either moves", () => {
  const hash = "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1";
  const approvedId = "22222222-2222-4222-8222-222222222222";
  const assets: CatalogueAsset[] = [
    {
      id: approvedId,
      name: "Starter room",
      kind: "environment",
      url: "room.glb",
      sha256: hash,
      thumbnail: null,
    },
    {
      id: "test-room-module-v1",
      name: "Starter room",
      kind: "model",
      url: "room.glb",
      sha256: hash,
      thumbnail: null,
    },
  ];
  function layout() {
    const store = createDocumentStore(assets);
    expect(store.createProject(approvedId).ok).toBe(true);
    const room = store.addObject("test-room-module-v1", [10, 0, 0]);
    if (!room.ok) throw Error(room.error);
    return { store, room: room.object, first: store.getSnapshot().activeSceneId! };
  }
  const moduleMove = layout();
  expect(
    moduleMove.store.setTransform(moduleMove.room.id, {
      ...moduleMove.room.transform,
      position: [-4, 0, 8],
    }).ok,
  ).toBe(true);
  expect(moduleMove.store.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 10]);

  const gesture = layout();
  const edit = gesture.store.beginTransform(gesture.room.id);
  if (!edit.ok) throw Error(edit.error.message);
  const preview = gesture.store.previewTransform(edit.value.token, {
    ...gesture.room.transform,
    position: [-4, 0, 8],
  });
  expect(preview.ok && preview.value.after.position).toEqual([-4, 0, 8]);
  expect(gesture.store.commitTransformEdit(edit.value.token).ok).toBe(true);
  expect(gesture.store.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 10]);

  const initialMove = layout();
  expect(
    initialMove.store.setSelectionTransform([initialMove.first], initialMove.first, {
      position: [7, 0, 8],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }).ok,
  ).toBe(true);
  expect(
    initialMove.store.getSnapshot().project!.scenes[0]!.environmentTransform!.position,
  ).toEqual([10, 0, 10]);
  expect(initialMove.store.getSnapshot().project!.scenes[0]!.environmentAssetId).toBe(approvedId);

  const different = createDocumentStore([{ ...assets[0]!, sha256: "b".repeat(64) }, assets[1]!]);
  expect(different.createProject(approvedId).ok).toBe(true);
  const unrelatedRoom = different.addObject("test-room-module-v1", [10, 0, 0]);
  if (!unrelatedRoom.ok) throw Error(unrelatedRoom.error);
  expect(
    different.setTransform(unrelatedRoom.object.id, {
      ...unrelatedRoom.object.transform,
      position: [-4, 0, 8],
    }).ok,
  ).toBe(true);
  expect(different.getSnapshot().objects[0]!.transform.position).toEqual([-4, 0, 8]);
});

it("places and moves an approved Starter model without changing its UUID", () => {
  const hash = "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1";
  const environmentId = "22222222-2222-4222-8222-222222222222";
  const modelId = "33333333-3333-4333-8333-333333333333";
  const objectId = "44444444-4444-4444-8444-444444444444";
  const assets: CatalogueAsset[] = [
    {
      id: environmentId,
      name: "Starter room",
      kind: "environment",
      url: "room.glb",
      sha256: hash,
      thumbnail: null,
    },
    {
      id: modelId,
      name: "Starter room",
      kind: "model",
      url: "room.glb",
      sha256: hash,
      thumbnail: null,
    },
    {
      id: objectId,
      name: "Exhibit",
      kind: "model",
      url: "exhibit.glb",
      sha256: "b".repeat(64),
      thumbnail: null,
    },
  ];
  const store = createDocumentStore(assets);
  expect(store.createProject(environmentId).ok).toBe(true);
  const added = store.addObject(modelId, [7.46, 0, -5.35]);
  if (!added.ok) throw Error(added.error);
  expect(added.object.assetId).toBe(modelId);
  expect(added.object.transform.position).toEqual([10, 0, 0]);
  expect(added.object.name).toBe("Starter room 2");
  expect(store.addObject(modelId, [0, 0, 0], added.object.id).ok).toBe(false);
  const child = store.addObject(objectId, [11, 0, 1], added.object.id);
  if (!child.ok) throw Error(child.error);
  expect(store.reparent(added.object.id, child.object.id).ok).toBe(false);
  expect(store.addAttachedObject(modelId, child.object.id, [1, 0, 1]).ok).toBe(false);
  expect(
    store.setPlacedTransform(added.object.id, added.object.transform, child.object.id).ok,
  ).toBe(false);
  expect(
    store.setPlacedTransform(added.object.id, { ...added.object.transform, scale: [2, 2, 2] }, null)
      .ok,
  ).toBe(false);
  expect(
    store.setTransform(added.object.id, { ...added.object.transform, scale: [2, 2, 2] }).ok,
  ).toBe(false);
  expect(
    store.setTransform(added.object.id, { ...added.object.transform, position: [-4, 0, 8] }).ok,
  ).toBe(true);
  expect(store.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 10]);
  expect(store.getSnapshot().objects[1]!.transform.position).toEqual([1, 0, 11]);
  expect(store.getSnapshot().objects[1]).toMatchObject({ parentId: added.object.id });
  store.undo();
  expect(store.getSnapshot().objects[0]!.transform.position).toEqual([10, 0, 0]);
  store.redo();
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const saved = serializeProject(store.getSnapshot().project!, kinds);
  if (!saved.ok) throw Error(saved.error.message);
  const reopened = createDocumentStore(assets);
  expect(reopened.loadProject(saved.value, kinds).ok).toBe(true);
  expect(reopened.getSnapshot().project!.scenes[0]!.environmentAssetId).toBe(environmentId);
  expect(reopened.getSnapshot().objects[0]!.assetId).toBe(modelId);
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 10]);

  const hidden = createDocumentStore(assets);
  expect(hidden.createProject(environmentId).ok).toBe(true);
  const remaining = hidden.addObject(modelId, [10, 0, 0]);
  if (!remaining.ok) throw Error(remaining.error);
  expect(hidden.deleteObject(hidden.getSnapshot().activeSceneId!).ok).toBe(true);
  const rotation = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] as const;
  expect(
    hidden.setTransform(remaining.object.id, { ...remaining.object.transform, rotation }).ok,
  ).toBe(true);
  const next = hidden.addObject(modelId, [3, 0, 7]);
  if (!next.ok) throw Error(next.error);
  expect(next.object.transform.rotation).toEqual(
    hidden.getSnapshot().objects[0]!.transform.rotation,
  );
  expect(
    Math.hypot(
      next.object.transform.position[0] - remaining.object.transform.position[0],
      next.object.transform.position[2] - remaining.object.transform.position[2],
    ),
  ).toBeCloseTo(10);
});

it("snaps rooms to vacant adjoining sides while preserving undo and saved positions", () => {
  const assets: CatalogueAsset[] = ["test-room-v1", "test-room-module-v1", "test-crate-v1"].map(
    (id) => ({
      id,
      name: id,
      kind: id === "test-room-v1" ? "environment" : "model",
      url: `${id}.glb`,
      sha256: "0".repeat(64),
      thumbnail: null,
    }),
  );
  const store = createDocumentStore(assets);
  assert.equal(store.createProject("test-room-v1").ok, true);
  const add = (position: readonly [number, number, number]) => {
    const result = store.addObject("test-room-module-v1", position);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.error);
    return result.object;
  };
  // Proximity chooses all four sides while occupied sides extend the layout outward
  assert.deepEqual(add([8, 9, 1]).transform.position, [10, 0, 0]);
  assert.deepEqual(add([-8, 0, 1]).transform.position, [-10, 0, 0]);
  assert.deepEqual(add([1, 0, 8]).transform.position, [0, 0, 10]);
  assert.deepEqual(add([1, 0, -8]).transform.position, [0, 0, -10]);
  const blocked = store.getSnapshot();
  assert.equal(store.addObject("test-room-module-v1", [39, 0, 0]).ok, false);
  assert.equal(store.getSnapshot(), blocked);
  const next = add([9, 0, 9]);
  assert.deepEqual(next.transform.position, [10, 0, 10]);
  store.undo();
  assert.equal(
    store.getSnapshot().objects.some((object) => object.id === next.id),
    false,
  );
  store.redo();
  assert.deepEqual(store.getSnapshot().objects.at(-1), next);
  // Reopening uses the saved snapped transform without a runtime-only correction
  const reopened = createDocumentStore(assets);
  assert.equal(
    reopened.loadProject(
      JSON.stringify(store.getSnapshot().project),
      new Map(assets.map((asset) => [asset.id, asset.kind])),
    ).ok,
    true,
  );
  assert.deepEqual(reopened.getSnapshot().objects, store.getSnapshot().objects);
  const crate = store.addObject("test-crate-v1", [2, 3, 4]);
  assert.equal(crate.ok, true);
  if (crate.ok) assert.deepEqual(crate.object.transform.position, [2, 3, 4]);
  const before = store.getSnapshot();
  assert.equal(store.addObject("test-room-module-v1", [NaN, 0, 0]).ok, false);
  assert.equal(store.getSnapshot(), before);
  // Previously saved scaled rooms remain readable and still supply their actual footprint.
  const imported = structuredClone(store.getSnapshot().project!);
  const existing = imported.scenes[0]!.objects.find((object) => object.id === next.id)!;
  Object.assign(existing, {
    transform: { ...existing.transform, position: [50, 0, 0], scale: [2, 1, 1] },
  });
  assert.equal(
    store.loadProject(
      JSON.stringify(imported),
      new Map(assets.map((asset) => [asset.id, asset.kind])),
    ).ok,
    true,
  );
  assert.deepEqual(
    store.getSnapshot().objects.find((object) => object.id === next.id)?.transform.position,
    [50, 0, 0],
  );
  assert.equal(store.addObject("test-room-module-v1", [65, 0, 0]).ok, false);
});

it("rejects room scaling in direct edits and previews while allowing movement and normal object scaling", () => {
  const assets: CatalogueAsset[] = ["test-room-v1", "test-room-module-v1", "test-crate-v1"].map(
    (id) => ({
      id,
      name: id,
      kind: id === "test-room-v1" ? "environment" : "model",
      url: `${id}.glb`,
      sha256: "0".repeat(64),
      thumbnail: null,
    }),
  );
  const store = createDocumentStore(assets);
  store.createProject("test-room-v1");
  const added = store.addObject("test-room-module-v1", [10, 0, 0]);
  if (!added.ok) throw new Error(added.error);
  const room = added.object;
  const before = store.getSnapshot();
  assert.equal(store.setTransform(room.id, { ...room.transform, scale: [2, 2, 2] }).ok, false);
  assert.equal(store.getSnapshot(), before);
  const edit = store.beginTransform(room.id);
  if (!edit.ok) throw new Error(edit.error.message);
  assert.equal(
    store.previewTransform(edit.value.token, { ...room.transform, scale: [0.5, 0.5, 0.5] }).ok,
    false,
  );
  assert.equal(store.getTransformEdit(), null);
  assert.equal(store.getSnapshot(), before);
  assert.equal(store.setTransform(room.id, { ...room.transform, position: [20, 0, 0] }).ok, true);
  const crate = store.addObject("test-crate-v1", [0, 0, 0]);
  if (!crate.ok) throw new Error(crate.error);
  assert.equal(
    store.setTransform(crate.object.id, { ...crate.object.transform, scale: [2, 2, 2] }).ok,
    true,
  );
});

it("links hotspot playback to scene audio and removes only the hotspot and its rules", () => {
  // Keep one store-level regression for track removal and atomic restoration of its hotspot links
  const assets: CatalogueAsset[] = (
    [
      { id: "room", kind: "environment" },
      { id: "object", kind: "model" },
      { id: "audio", kind: "audio" },
    ] as const
  ).map((asset) => ({
    ...asset,
    name: asset.id,
    url: asset.id,
    sha256: "0".repeat(64),
    thumbnail: null,
  }));
  const store = createDocumentStore(assets);
  store.createProject("room");
  const placed = store.addObject("object", [0, 0, 0]);
  if (!placed.ok) throw Error("Placement failed");
  store.addAudio("audio", "global", null);
  const project = store.getSnapshot().project!;
  if (project.schemaVersion !== 2) throw Error("Expected content project");
  const mediaId = project.scenes[0]!.audio![0]!.id;
  const hotspot = store.addHotspot(placed.object.id);
  if (!hotspot.ok) throw Error("Hotspot failed");
  const rule = {
    when: { type: "visitor-clicks-hotspot" as const, targetHotspotId: hotspot.value.id },
    do: { type: "play-audio" as const, mediaId },
  };
  expect(store.setInteractions([rule]).ok).toBe(true);
  const linked = store.getSnapshot().project!;
  const registry = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const saved = serializeProject(linked, registry);
  if (!saved.ok) throw Error(saved.error.message);
  const reopened = deserializeProject(saved.value, registry);
  expect(reopened.ok).toBe(true);
  if (reopened.ok) expect(reopened.value.scenes[0]!.interactions[0]!.do).toEqual(rule.do);
  expect(
    store.setInteractions([{ ...rule, do: { type: "play-audio", mediaId: placed.object.id } }]).ok,
  ).toBe(false);
  expect(store.removeAudio(mediaId).ok).toBe(true);
  expect(store.getSnapshot().project!.scenes[0]!.interactions).toHaveLength(0);
  expect(store.getSnapshot().project!.scenes[0]!.hotspots).toHaveLength(1);
  store.undo();
  expect(store.getSnapshot().project).toEqual(linked);
  expect(store.deleteHotspot(hotspot.value.id).ok).toBe(true);
  expect(store.getSnapshot().project!.scenes[0]!.interactions).toHaveLength(0);
  expect(store.getSnapshot().objects).toHaveLength(1);
  store.undo();
  expect(store.getSnapshot().project).toEqual(linked);
});
