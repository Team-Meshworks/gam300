import { describe, expect, it } from "vitest";
import fixture from "../shared/project/fixtures/m1-project.json";
import { sampleAsset } from "../shared/assets/sample-asset";
import { serializeProject } from "../shared/project/project-serialization";
import { createDocumentStore } from "./document-store";

const assets = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
  [sampleAsset.id, "model"],
]);
const text = JSON.stringify(fixture);

describe("loading a project into the editor store", () => {
  it("replaces the whole project once and clears the previous placement history", () => {
    const store = createDocumentStore();
    store.addObject([0, 0, 0]);
    store.addObject([1, 0, 0]);
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
    const store = createDocumentStore();
    store.loadProject(text, assets);
    const first = store.addObject([1, 0, 0]);
    const second = store.addObject([2, 0, 0]);
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
    const store = createDocumentStore();
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
    expect(store.addObject([3, 0, -1]).ok).toBe(true);
    const edited = store.getSnapshot();
    expect(edited.objects).toBe(edited.project?.scenes[0]?.objects);
    expect(edited.project?.projectId).toBe(fixture.projectId);
    expect(edited.project?.scenes[0]?.startCamera).toEqual(fixture.scenes[0]?.startCamera);
    const saved = serializeProject(edited.project, assets);
    if (!saved.ok) throw new Error(saved.error.message);
    const reopened = createDocumentStore();
    expect(reopened.loadProject(saved.value, assets).ok).toBe(true);
    expect(reopened.getSnapshot().project).toEqual(edited.project);
    expect(loaded.project).toEqual(fixture);
    store.undo();
    expect(store.getSnapshot().project).toEqual(fixture);
    store.redo();
    expect(store.getSnapshot().project).toEqual(edited.project);
  });

  it("rejects placement when the loaded catalog has no sample model", () => {
    const store = createDocumentStore();
    const catalog = new Map(assets);
    catalog.delete(sampleAsset.id);
    store.loadProject(text, catalog);
    const before = store.getSnapshot();
    expect(store.addObject([0, 0, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
});
