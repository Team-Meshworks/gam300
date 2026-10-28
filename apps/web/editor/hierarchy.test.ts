import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import m1 from "../shared/project/fixtures/m1-project.json";
import manifest from "../shared/project/fixtures/project-format-cases.json";
import type { ContentProject } from "../shared/project/project-content";
import type { CatalogueAsset } from "../shared/assets/catalogue";

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
const content = (store: ReturnType<typeof setup>) => store.getSnapshot().project as ContentProject;

// Exercise hierarchy edits through the same store used by panels and keyboard commands
// Assertions cover portable JSON and local history independently so neither can hide data loss
describe("authored hierarchy", () => {
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
});
