import { describe, expect, it } from "vitest";
import fixture from "../shared/project/fixtures/m1-project.json";
import type { CatalogueAsset } from "../shared/assets/catalogue";
import { sampleAsset } from "../shared/assets/sample-asset";
import { serializeProject } from "../shared/project/project-serialization";
import { createDocumentStore } from "./document-store";

const assets = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
  [sampleAsset.id, "model"],
]);
const placementAssets: CatalogueAsset[] = [...assets.keys()].map((id) => ({
  id,
  name: id,
  kind: id === "test-room-v1" ? "environment" : "model",
  url: `${id}.glb`,
  thumbnail: null,
}));
const text = JSON.stringify(fixture);

describe("loading a project into the editor store", () => {
  it("places catalog models in loaded projects without accepting environments as objects", () => {
    const store = createDocumentStore(placementAssets);
    store.loadProject(text, assets);
    const before = store.getSnapshot();
    expect(store.addObject("test-room-v1", [0, 0, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.addObject("test-crate-v1", [0, 0, 0]).ok).toBe(true);
    expect(serializeProject(store.getSnapshot().project, assets).ok).toBe(true);
  });

  it("replaces the whole project once and clears the previous placement history", () => {
    const store = createDocumentStore(placementAssets);
    store.addObject(sampleAsset.id, [0, 0, 0]);
    store.addObject(sampleAsset.id, [1, 0, 0]);
    store.undo();
    const previous = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => notifications++);

    expect(store.loadProject(text, assets)).toEqual({ ok: true, value: fixture });
    const loaded = store.getSnapshot();
    expect(loaded.project).toEqual(fixture);
    expect(loaded.objects).toBe(loaded.project?.scenes[0]?.objects);
    expect(loaded.canUndo).toBe(false);
    expect(loaded.canRedo).toBe(false);
    expect(notifications).toBe(1);
    store.undo();
    store.redo();
    expect(store.getSnapshot()).toBe(loaded);
    expect(previous.objects).toHaveLength(1);
    expect(previous.canRedo).toBe(true);
  });

  it("keeps the exact snapshot and both history stacks after rejected loads", () => {
    const store = createDocumentStore(placementAssets);
    store.loadProject(text, assets);
    const first = store.addObject(sampleAsset.id, [1, 0, 0]);
    const second = store.addObject(sampleAsset.id, [2, 0, 0]);
    if (!first.ok || !second.ok) throw new Error("Placement setup failed");
    store.undo();
    const previous = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => notifications++);

    const failures = [
      "{",
      JSON.stringify({ ...fixture, schemaVersion: 99 }),
      text.replace("test-crate-v1", "missing-model"),
    ];
    for (const invalidText of failures) {
      expect(store.loadProject(invalidText, assets).ok).toBe(false);
      expect(store.getSnapshot()).toBe(previous);
    }
    expect(notifications).toBe(0);
    store.redo();
    expect(store.getSnapshot().objects.at(-1)?.id).toBe(second.object.id);
    store.undo();
    store.undo();
    expect(store.getSnapshot().objects).toEqual(fixture.scenes[0]?.objects);
  });

  it("keeps loaded snapshots immutable and serializes later edits from the same document", () => {
    const store = createDocumentStore(placementAssets);
    const catalog = new Map(assets);
    store.loadProject(text, catalog);
    const loaded = store.getSnapshot();
    const object = loaded.objects[0];
    expect(Object.isFrozen(loaded.project)).toBe(true);
    expect(Object.isFrozen(loaded.project?.scenes)).toBe(true);
    expect(Object.isFrozen(object?.transform.position)).toBe(true);
    expect(Object.isFrozen(loaded.project?.scenes[0]?.startCamera.rotation)).toBe(true);

    // Later caller changes to the catalog can't silently change this session
    catalog.clear();
    expect(store.addObject(sampleAsset.id, [3, 0, -1]).ok).toBe(true);
    const edited = store.getSnapshot();
    expect(edited.objects).toBe(edited.project?.scenes[0]?.objects);
    expect(edited.project?.projectId).toBe(fixture.projectId);
    expect(edited.project?.scenes[0]?.startCamera).toEqual(fixture.scenes[0]?.startCamera);
    const saved = serializeProject(edited.project, assets);
    if (!saved.ok) throw new Error(saved.error.message);
    const reopened = createDocumentStore(placementAssets);
    expect(reopened.loadProject(saved.value, assets).ok).toBe(true);
    expect(reopened.getSnapshot().project).toEqual(edited.project);
    expect(loaded.project).toEqual(fixture);
    store.undo();
    expect(store.getSnapshot().project).toEqual(fixture);
    store.redo();
    expect(store.getSnapshot().project).toEqual(edited.project);
  });

  it("rejects placement when the loaded catalog has no sample model", () => {
    const store = createDocumentStore(placementAssets);
    const catalog = new Map(assets);
    catalog.delete(sampleAsset.id);
    store.loadProject(text, catalog);
    const before = store.getSnapshot();
    expect(store.addObject(sampleAsset.id, [0, 0, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });

  it("keeps a moved loaded object in the document, history and exported JSON", () => {
    const store = createDocumentStore(placementAssets);
    expect(store.loadProject(text, assets).ok).toBe(true);
    const before = store.getSnapshot();
    const object = before.objects[0];
    if (object === undefined) throw new Error("Fixture needs an object");
    expect(store.setTransform(object.id, { ...object.transform, position: [4, 2, -1] })).toEqual({
      ok: true,
      changed: true,
    });
    const moved = store.getSnapshot();
    expect(moved.project?.scenes[0]?.objects).toBe(moved.objects);
    expect(moved.objects[0]?.transform.position).toEqual([4, 2, -1]);
    expect(before.objects[0]?.transform.position).toEqual(object.transform.position);
    const saved = serializeProject(moved.project, assets);
    if (!saved.ok) throw new Error(saved.error.message);
    const reopened = createDocumentStore(placementAssets);
    expect(reopened.loadProject(saved.value, assets).ok).toBe(true);
    expect(reopened.getSnapshot().objects[0]?.transform.position).toEqual([4, 2, -1]);
    store.undo();
    expect(store.getSnapshot().objects[0]?.transform.position).toEqual(object.transform.position);
    store.redo();
    expect(store.getSnapshot().objects[0]?.transform.position).toEqual([4, 2, -1]);
  });
});
