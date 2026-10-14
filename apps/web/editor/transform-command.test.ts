import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import type { CatalogueAsset } from "../shared/assets/catalogue";
import type { Transform } from "../shared/project/project-types";
import fixture from "../shared/project/fixtures/m1-project.json";
import { serializeProject } from "../shared/project/project-serialization";
const assets: CatalogueAsset[] = [
  {
    id: "test-crate-v1",
    name: "Crate",
    kind: "model",
    url: "crate.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];
function setup() {
  const store = createDocumentStore(assets);
  const added = store.addObject("test-crate-v1", [0, 0, 0]);
  if (!added.ok) throw new Error(added.error);
  return { store, object: added.object };
}
describe("transform commands", () => {
  it.each([
    { position: [3, 2, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { position: [0, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
    { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 3, 4] },
  ])("undoes and redoes a transform without changing identity or earlier snapshots", (after) => {
    const { store, object } = setup();
    const old = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => notifications++);
    expect(
      store.commitTransform({ objectId: object.id, before: object.transform, after }),
    ).toMatchObject({ ok: true, value: { changed: true } });
    const edited = store.getSnapshot().objects[0]!;
    expect(edited.id).toBe(object.id);
    expect(edited.assetId).toBe(object.assetId);
    expect(edited.name).toBe(object.name);
    for (let i = 0; i < 3; i++) {
      store.undo();
      expect(store.getSnapshot().objects[0]).toBe(object);
      store.redo();
      expect(store.getSnapshot().objects[0]).toBe(edited);
    }
    expect(old.objects[0]).toBe(object);
    expect(notifications).toBe(7);
  });
  it("rejects stale edits and invalid transforms without disturbing redo", () => {
    const { store, object } = setup();
    store.commitTransform({
      objectId: object.id,
      before: object.transform,
      after: { ...object.transform, position: [3, 0, 0] },
    });
    expect(
      store.commitTransform({
        objectId: object.id,
        before: object.transform,
        after: object.transform,
      }).ok,
    ).toBe(false);
    store.undo();
    const snapshot = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => notifications++);
    for (const input of [
      null,
      {},
      { objectId: "missing", before: object.transform, after: object.transform },
      ...[
        { position: [NaN, 0, 0] },
        { position: [10001, 0, 0] },
        { scale: [-1, 1, 1] },
        { rotation: [0, 0, 0, 0] },
      ].map((patch) => ({
        objectId: object.id,
        before: object.transform,
        after: { ...object.transform, ...patch },
      })),
    ]) {
      expect(store.commitTransform(input).ok).toBe(false);
      expect(store.getSnapshot()).toBe(snapshot);
    }
    expect(notifications).toBe(0);
    expect(store.getSnapshot().canRedo).toBe(true);
  });
  it("ignores unchanged transforms and equivalent quaternion signs, but branches on a real edit", () => {
    const { store, object } = setup();
    store.commitTransform({
      objectId: object.id,
      before: object.transform,
      after: { ...object.transform, scale: [2, 2, 2] },
    });
    store.undo();
    const snapshot = store.getSnapshot();
    expect(
      store.commitTransform({
        objectId: object.id,
        before: object.transform,
        after: { ...object.transform, rotation: [0, 0, 0, -1] },
      }),
    ).toMatchObject({ ok: true, value: { changed: false } });
    expect(store.getSnapshot()).toBe(snapshot);
    store.commitTransform({
      objectId: object.id,
      before: object.transform,
      after: { ...object.transform, position: [1, 0, 0] },
    });
    expect(store.getSnapshot().canRedo).toBe(false);
    store.undo();
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.redo();
    store.redo();
    expect(store.getSnapshot().objects[0]?.transform.position).toEqual([1, 0, 0]);
  });
  it("copies caller arrays and freezes the committed transform", () => {
    const { store, object } = setup();
    const after = { position: [3, 0, 0], rotation: [0, 0, 0, 1.0000001], scale: [2, 2, 2] };
    expect(store.commitTransform({ objectId: object.id, before: object.transform, after }).ok).toBe(
      true,
    );
    after.position[0] = 99;
    after.scale[0] = 99;
    const saved = store.getSnapshot().objects[0]!.transform;
    expect(saved.position).toEqual([3, 0, 0]);
    expect(saved.scale).toEqual([2, 2, 2]);
    expect(saved.rotation).toEqual([0, 0, 0, 1]);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.position)).toBe(true);
    store.undo();
    store.redo();
    expect(store.getSnapshot().objects[0]!.transform).toBe(saved);
  });
  it("keeps loaded projects serializable and preserves scene ordering and neighbours", () => {
    const { store } = setup();
    const kinds = new Map([
      ["test-room-v1", "environment"],
      ["test-crate-v1", "model"],
    ]);
    expect(store.loadProject(JSON.stringify(fixture), kinds).ok).toBe(true);
    store.addObject("test-crate-v1", [4, 0, 0]);
    const before = store.getSnapshot();
    const first = before.objects[0]!;
    const after: Transform = { ...first.transform, position: [2, 0, 0] };
    store.commitTransform({ objectId: first.id, before: first.transform, after });
    const changed = store.getSnapshot();
    expect(changed.objects[1]).toBe(before.objects[1]);
    expect(changed.project?.scenes[0]?.objects).toBe(changed.objects);
    const encoded = serializeProject(changed.project, kinds);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(store.loadProject(encoded.value, kinds).ok).toBe(true);
    expect(store.getSnapshot().objects[0]?.transform.position).toEqual([2, 0, 0]);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().canRedo).toBe(false);
  });
});
