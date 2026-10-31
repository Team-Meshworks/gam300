import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import { validateRecoveryHistory } from "./recovery-history";
import { serializeProject } from "../shared/project/project-serialization";
import m1 from "../shared/project/fixtures/m1-project.json";
import m2 from "../shared/project/fixtures/m2-project.json";
import manifest from "../shared/project/fixtures/project-format-cases.json";
import type { ContentProject } from "../shared/project/project-content";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";

const kinds = new Map(Object.entries(manifest.assets));
const assets = ["test-room-v1", "test-crate-v1"].map((id) => ({
  id,
  name: id,
  kind: kinds.get(id),
  url: `${id}.glb`,
  thumbnail: null,
  sha256: "0".repeat(64),
})) as CatalogueAsset[];
function setup(document: unknown = m1) {
  const store = createDocumentStore(assets);
  expect(store.loadProject(JSON.stringify(document), kinds).ok).toBe(true);
  return store;
}
function group(store: ReturnType<typeof setup>, name: string, parent: string | null = null) {
  const result = store.createGroup(name, parent);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const content = (store: ReturnType<typeof setup>) => store.getSnapshot().project as ContentProject;

// Exercise hierarchy edits through the same store used by panels and keyboard commands
// Assertions cover portable JSON and local history independently so neither can hide data loss
describe("authored hierarchy", () => {
  it("renames the first room and retains its undo history across recovery", () => {
    const store = setup();
    const scene = store.getSnapshot().project!.scenes[0]!;
    expect(store.renameObject(scene.id, "Main gallery").ok).toBe(true);
    const renamed = store.getSnapshot().project!;
    const recovered = validateRecoveryHistory(store.getRecoveryHistory(), renamed, kinds);
    expect(recovered.ok).toBe(true);
    expect(
      store.loadProject(JSON.stringify(renamed), kinds, recovered.ok ? recovered.value : undefined)
        .ok,
    ).toBe(true);
    store.undo();
    expect(store.getSnapshot().project!.scenes[0]!.name).toBe(scene.name);
    store.redo();
    expect(store.getSnapshot().project!.scenes[0]!.name).toBe("Main gallery");
  });
  it("renames only the placed instance and preserves identity through undo and redo", () => {
    const store = setup();
    const before = store.getSnapshot().objects[0]!;
    expect(store.renameObject(before.id, "  Display pedestal  ").ok).toBe(true);
    expect(store.getSnapshot().objects[0]).toEqual({ ...before, name: "Display pedestal" });
    const renamed = store.getSnapshot();
    expect(store.renameObject(before.id, " ").ok).toBe(false);
    expect(store.getSnapshot()).toBe(renamed);
    store.undo();
    expect(store.getSnapshot().objects[0]).toEqual(before);
    store.redo();
    expect(store.getSnapshot().objects[0]!.name).toBe("Display pedestal");
  });
  it("rejects room nesting without changing the document or history", () => {
    const roomModel = {
      ...assets[1]!,
      id: "test-room-module-v1",
      name: "test-room",
      kind: "model" as const,
    };
    const store = createDocumentStore([...assets, roomModel]);
    store.createProject("test-room-v1");
    const room = store.addObject(roomModel.id, [10, 0, 0]);
    const crate = store.addObject("test-crate-v1", [0, 0, 0]);
    if (!room.ok || !crate.ok) throw new Error("Fixture placement failed");
    const before = store.getSnapshot();
    expect(store.reparent(room.object.id, crate.object.id).ok).toBe(false);
    expect(store.addObject(roomModel.id, [20, 0, 0], crate.object.id).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
  it("adds under the selected parent atomically and treats repeated reparenting as a no-op", () => {
    const store = setup();
    const parent = store.getSnapshot().objects[0]!;
    const added = store.addObject("test-crate-v1", [3, 0, 4], parent.id);
    expect(added.ok).toBe(true);
    const current = content(store).scenes[0]!;
    expect(current.objects.at(-1)!.parentId).toBe(parent.id);
    const before = store.getSnapshot();
    expect(store.reparent(current.objects.at(-1)!.id, parent.id).ok).toBe(true);
    expect(store.getSnapshot()).toBe(before);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(2);
    store.redo();
    expect(content(store).scenes[0]!.objects.at(-1)!.parentId).toBe(parent.id);
    const restored = store.getSnapshot();
    expect(store.addObject("test-crate-v1", [0, 0, 0], "missing").ok).toBe(false);
    expect(store.getSnapshot()).toBe(restored);
  });
  it("upgrades on the first group edit and retains earlier object undo steps", () => {
    const store = setup();
    const object = store.getSnapshot().objects[0]!;
    const moved = { ...object.transform, position: [4, 0, 0] as const };
    store.setTransform(object.id, moved);
    const folder = group(store, "Exhibit A");
    expect(content(store).schemaVersion).toBe(2);
    expect(store.reparent(object.id, folder.id).ok).toBe(true);
    expect(content(store).scenes[0]!.objects[0]!.transform).toEqual(moved);
    store.undo();
    expect(content(store).scenes[0]!.objects[0]!.parentId).toBeNull();
    store.undo();
    expect(content(store).scenes[0]!.groups).toEqual([]);
    store.undo();
    expect(store.getSnapshot().objects[0]!.transform).toEqual(object.transform);
    store.redo();
    store.redo();
    store.redo();
    expect(content(store).scenes[0]!.objects[0]!.parentId).toBe(folder.id);
  });

  it("rejects cycles, missing parents and invalid names atomically", () => {
    const store = setup();
    const outer = group(store, "Outer");
    const inner = group(store, "Inner", outer.id);
    const before = store.getSnapshot();
    expect(store.reparent(outer.id, inner.id).ok).toBe(false);
    expect(store.reparent(inner.id, inner.id).ok).toBe(false);
    expect(store.reparent(inner.id, crypto.randomUUID()).ok).toBe(false);
    expect(store.createGroup(" ").ok).toBe(false);
    expect(store.renameGroup(inner.id, " ").ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });

  it("supports object parents and releases children when ungrouping without moving them", () => {
    const store = setup();
    const object = store.getSnapshot().objects[0]!;
    const folder = group(store, "Exhibit", object.id);
    const nested = group(store, "Labels", folder.id);
    const child = store.getSnapshot().objects[1]!;
    store.reparent(child.id, folder.id);
    expect(store.ungroup(folder.id).ok).toBe(true);
    expect(content(store).scenes[0]!.groups[0]).toMatchObject({
      id: nested.id,
      parentId: object.id,
    });
    expect(content(store).scenes[0]!.objects[1]).toMatchObject({
      parentId: object.id,
      transform: child.transform,
    });
    store.undo();
    expect(content(store).scenes[0]!.groups).toHaveLength(2);
    expect(content(store).scenes[0]!.objects[1]!.parentId).toBe(folder.id);
  });

  it("reopens group edits and both undo stacks through repeated recovery validation", () => {
    const store = setup();
    const folder = group(store, "Exhibit A");
    const id = store.getSnapshot().objects[0]!.id;
    store.reparent(id, folder.id);
    store.renameGroup(folder.id, "Gallery");
    store.undo();
    const saved = serializeProject(content(store), kinds);
    if (!saved.ok) throw new Error(saved.error.message);
    // IndexedDB validates history on write and again on read before the store restores it
    const first = validateRecoveryHistory(store.getRecoveryHistory(), content(store), kinds);
    if (!first.ok) throw new Error(first.error.message);
    const second = validateRecoveryHistory(
      JSON.parse(JSON.stringify(first.value)),
      content(store),
      kinds,
    );
    if (!second.ok) throw new Error(second.error.message);
    const reopened = setup();
    expect(reopened.loadProject(saved.value, kinds, second.value).ok).toBe(true);
    reopened.redo();
    expect(content(reopened).scenes[0]!.groups[0]!.name).toBe("Gallery");
    reopened.undo();
    reopened.undo();
    reopened.undo();
    expect(content(reopened).scenes[0]!.groups).toEqual([]);
    expect(content(reopened).scenes[0]!.objects[0]!.parentId).toBeNull();
  });

  it("retains other scenes and attached content and rejects damaged recovered groups", () => {
    const store = setup(m2);
    const original = content(store);
    group(store, "New exhibit");
    expect(content(store).scenes[1]).toBe(original.scenes[1]);
    expect(content(store).scenes[0]!.rules).toBe(original.scenes[0]!.rules);
    expect(content(store).scenes[0]!.objects).toEqual(original.scenes[0]!.objects);
    const history = JSON.parse(JSON.stringify(store.getRecoveryHistory()));
    history.past[0].groups[0].parentId = history.past[0].groups[0].id;
    const before = store.getSnapshot();
    expect(store.loadProject(JSON.stringify(content(store)), kinds, history).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });

  it("still opens legacy object-only histories for a v2 document", () => {
    const store = setup(m2);
    const scene = content(store).scenes[0]!;
    const old = {
      version: 1,
      projectId: m2.projectId,
      sceneId: scene.id,
      current: scene.objects,
      past: [],
      future: [],
    };
    const result = validateRecoveryHistory(old, content(store), kinds);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(validateRecoveryHistory(result.value, content(store), kinds).ok).toBe(true);
  });
});
