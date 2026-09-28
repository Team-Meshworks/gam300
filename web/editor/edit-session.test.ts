import { expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import fixture from "../shared/project/fixtures/m1-project.json";
import { serializeProject } from "../shared/project/project-serialization";
const assets = [
  { id: "test-crate-v1", name: "Crate", kind: "model" as const, url: "crate.glb", thumbnail: null },
];
const kinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
function setup() {
  const store = createDocumentStore(assets);
  const added = store.addObject("test-crate-v1", [0, 0, 0]);
  if (!added.ok) throw new Error(added.error);
  const session = store.beginTransform(added.object.id);
  if (!session.ok) throw new Error(session.error.message);
  return { store, object: added.object, token: session.value.token };
}
it("100 previews become one edit and leave committed snapshots alone until release", () => {
  const { store, object, token } = setup();
  const initial = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => notifications++);
  for (let x = 1; x <= 100; x++) {
    expect(store.previewTransform(token, { ...object.transform, position: [x, 0, 0] }).ok).toBe(
      true,
    );
    expect(store.getSnapshot()).toBe(initial);
  }
  expect(notifications).toBe(0);
  expect(store.commitTransformEdit(token)).toMatchObject({ ok: true, value: { changed: true } });
  expect(notifications).toBe(1);
  expect(store.getTransformEdit()).toBeNull();
  store.undo();
  expect(store.getSnapshot().objects[0]).toBe(object);
  store.redo();
  expect(store.getSnapshot().objects[0]?.transform.position).toEqual([100, 0, 0]);
  expect(store.commitTransformEdit(token).ok).toBe(false);
});
it("cancel preserves redo, and old tokens cannot cancel or commit a new session", () => {
  const { store, object, token } = setup();
  store.previewTransform(token, { ...object.transform, position: [2, 0, 0] });
  store.commitTransformEdit(token);
  store.undo();
  const snapshot = store.getSnapshot();
  const session = store.beginTransform(object.id);
  if (!session.ok) throw new Error();
  store.previewTransform(session.value.token, { ...object.transform, position: [5, 0, 0] });
  store.cancelTransformEdit(token);
  expect(store.getTransformEdit()?.token).toBe(session.value.token);
  expect(store.commitTransformEdit(token).ok).toBe(false);
  store.cancelTransformEdit(session.value.token);
  expect(store.getSnapshot()).toBe(snapshot);
  expect(store.getSnapshot().canRedo).toBe(true);
});
it("invalid previews end the session and cannot commit an earlier valid preview", () => {
  const { store, object, token } = setup();
  const snapshot = store.getSnapshot();
  store.previewTransform(token, { ...object.transform, position: [3, 0, 0] });
  expect(store.previewTransform(token, { ...object.transform, scale: [0, 1, 1] }).ok).toBe(false);
  expect(store.getTransformEdit()).toBeNull();
  expect(store.commitTransformEdit(token).ok).toBe(false);
  expect(store.getSnapshot()).toBe(snapshot);
});
it("unchanged sessions create no history and preview arrays cannot be mutated", () => {
  const { store, object, token } = setup();
  const snapshot = store.getSnapshot();
  const input = { ...object.transform, position: [0, 0, 0] };
  store.previewTransform(token, input);
  input.position[0] = 99;
  expect(store.getTransformEdit()?.after.position).toEqual([0, 0, 0]);
  expect(Object.isFrozen(store.getTransformEdit()?.after.position)).toBe(true);
  expect(store.commitTransformEdit(token)).toMatchObject({ ok: true, value: { changed: false } });
  expect(store.getSnapshot()).toBe(snapshot);
});
it.each(["undo", "redo", "load", "delete", "add", "direct"])(
  "%s invalidates active previews",
  (action) => {
    const { store, object, token } = setup();
    if (action === "undo") store.undo();
    if (action === "redo") store.redo();
    if (action === "load") store.loadProject(JSON.stringify(fixture), kinds);
    if (action === "delete") store.deleteObject(object.id);
    if (action === "add") store.addObject("test-crate-v1", [1, 0, 0]);
    if (action === "direct")
      store.commitTransform({
        objectId: object.id,
        before: object.transform,
        after: { ...object.transform, position: [3, 0, 0] },
      });
    expect(store.getTransformEdit()).toBeNull();
    expect(store.commitTransformEdit(token).ok).toBe(false);
  },
);
it("deletion restores identity, transform and the original middle slot repeatedly", () => {
  const { store } = setup();
  store.addObject("test-crate-v1", [2, 0, 0]);
  store.addObject("test-crate-v1", [4, 0, 0]);
  const before = store.getSnapshot();
  const middle = before.objects[1]!;
  expect(store.deleteObject(middle.id).ok).toBe(true);
  expect(store.getSnapshot().objects.map((o) => o.id)).toEqual([
    before.objects[0]!.id,
    before.objects[2]!.id,
  ]);
  for (let i = 0; i < 3; i++) {
    store.undo();
    expect(store.getSnapshot().objects).toEqual(before.objects);
    expect(store.getSnapshot().objects[1]).toBe(middle);
    store.redo();
    expect(store.getSnapshot().objects).toHaveLength(2);
  }
  expect(before.objects).toHaveLength(3);
});
it("missing deletion preserves redo; a real deletion starts a new branch", () => {
  const { store, object } = setup();
  store.addObject("test-crate-v1", [2, 0, 0]);
  store.undo();
  const snapshot = store.getSnapshot();
  expect(store.deleteObject("missing").ok).toBe(false);
  expect(store.getSnapshot()).toBe(snapshot);
  store.deleteObject(object.id);
  expect(store.getSnapshot().canRedo).toBe(false);
});
it("loaded projects serialize deletions, but never temporary previews", () => {
  const { store } = setup();
  store.loadProject(JSON.stringify(fixture), kinds);
  const initial = store.getSnapshot();
  const object = initial.objects[0]!;
  const started = store.beginTransform(object.id);
  if (!started.ok) throw new Error();
  store.previewTransform(started.value.token, { ...object.transform, position: [9, 0, 0] });
  expect(serializeProject(store.getSnapshot().project, kinds)).toEqual(
    serializeProject(initial.project, kinds),
  );
  store.deleteObject(object.id);
  expect(store.getSnapshot().project?.scenes[0]?.objects).toHaveLength(initial.objects.length - 1);
  expect(serializeProject(store.getSnapshot().project, kinds).ok).toBe(true);
  store.undo();
  expect(store.getSnapshot().objects[0]).toBe(object);
});
