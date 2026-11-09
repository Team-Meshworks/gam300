import { createLoadedStore } from "../tests/project-store-fixture";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SceneTreePanel } from "./ui/SceneTreePanel";
import { moveSceneSelection } from "../shared/project/selection-transform";
import { roomFitsGrid } from "../shared/project/room-placement";
import { deserializeProject } from "../shared/project/project-deserialization";
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
  it("lists a non-Starter room as a sibling of the initial room", () => {
    const roomAsset: CatalogueAsset = {
      id: "room-space1-module-v1",
      name: "Space1",
      kind: "model",
      url: "room.glb",
      sha256: "1".repeat(64),
      thumbnail: null,
    };
    const object = {
      id: "room-two",
      name: "Space1",
      assetId: roomAsset.id,
      transform: {
        position: [10, 0, 0] as const,
        rotation: [0, 0, 0, 1] as const,
        scale: [1, 1, 1] as const,
      },
    };
    const html = renderToStaticMarkup(
      createElement(SceneTreePanel, {
        assets: [roomAsset],
        room: { id: "room-one", name: "First", thumbnail: undefined },
        objects: [object],
        groups: [],
        hotspots: [],
        selectedId: null,
        onSelect() {},
        onDelete() {},
        mobileDevice: false,
        thumbnailFor: () => undefined,
        hierarchy: { rename: () => true, move() {} },
      }),
    );
    const initialRoomChildren = html.match(/<ul class="scene-objects"[^>]*>(.*?)<\/ul>/s)?.[1];
    expect(initialRoomChildren).toBeDefined();
    expect(initialRoomChildren).not.toContain('data-object-id="room-two"');
    expect(html).toContain('data-object-id="room-two"');
  });
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
      name: "Starter room",
      kind: "model" as const,
    };
    const store = createLoadedStore([...assets, roomModel], "test-room-v1");
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
  it("edits and recovers hierarchy in the active second scene without changing the first", () => {
    const store = setup(m2);
    const original = content(store);
    const second = original.scenes[1]!;
    expect(store.switchScene(second.id).ok).toBe(true);

    // Grouping, child placement and room renaming share dev's scene-aware history
    const parent = group(store, "Second gallery");
    const placed = store.addObject("test-crate-v1", [1, 0, 1], parent.id);
    expect(placed.ok).toBe(true);
    expect(store.renameObject(second.id, "Renamed gallery").ok).toBe(true);
    expect(content(store).scenes[0]).toBe(original.scenes[0]);
    if (!placed.ok) throw new Error(placed.error);
    expect(
      content(store).scenes[1]!.objects.find((object) => object.id === placed.object.id)!.parentId,
    ).toBe(parent.id);

    // Reopening must restore both the active scene and the complete reversible hierarchy
    const reopened = setup(m2);
    expect(
      reopened.loadProject(JSON.stringify(content(store)), kinds, store.getRecoveryHistory()).ok,
    ).toBe(true);
    expect(reopened.getSnapshot().activeSceneId).toBe(second.id);
    reopened.undo();
    expect(content(reopened).scenes[1]!.name).toBe(second.name);
    reopened.undo();
    expect(content(reopened).scenes[1]!.objects).toEqual(second.objects);
    reopened.undo();
    expect(content(reopened).scenes[1]!.groups).toEqual(second.groups);
    expect(content(reopened).scenes[0]).toEqual(original.scenes[0]);
    reopened.redo();
    reopened.redo();
    reopened.redo();
    expect(content(reopened)).toEqual(content(store));
  });
});

it("deletes a group with nested groups and objects while preserving siblings and restoring the branch with Undo", () => {
  const store = setup();
  const root = group(store, "Parent");
  const nested = group(store, "Child", root.id);
  const sibling = group(store, "Keep me");
  const objects = store.getSnapshot().objects;
  expect(store.reparent(objects[0]!.id, nested.id).ok).toBe(true);
  expect(store.reparent(objects[1]!.id, root.id).ok).toBe(true);
  const before = store.getSnapshot().project;
  expect(store.deleteObject(root.id).ok).toBe(true);
  expect(store.getSnapshot().objects).toHaveLength(0);
  expect(content(store).scenes[0]!.groups.map((entry) => entry.id)).toEqual([sibling.id]);
  store.undo();
  expect(store.getSnapshot().project).toEqual(before);
  store.redo();
  expect(store.getSnapshot().objects).toHaveLength(0);
});

// Keep room command regressions beside the hierarchy and history behavior they preserve
describe("room layouts", () => {
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
  function layout() {
    const store = createLoadedStore(assets, "test-room-v1");
    const a = store.addObject("test-room-module-v1", [10, 0, 0]);
    const b = store.addObject("test-room-module-v1", [10, 0, 10]);
    if (!a.ok || !b.ok) throw new Error("Could not create rooms");
    return { store, a: a.object, b: b.object, first: store.getSnapshot().activeSceneId! };
  }
  it("moves all selected rooms including the initial room and attached contents exactly once in one undo step", () => {
    const { store, a, b, first } = layout();
    const crate = store.addObject("test-crate-v1", [11, 0, 1], a.id);
    if (!crate.ok) throw new Error(crate.error);
    const before = store.getSnapshot().project;
    expect(
      store.setSelectionTransform([first, a.id, b.id, crate.object.id], a.id, {
        ...a.transform,
        position: [13, 0, 4],
      }).ok,
    ).toBe(true);
    const project = store.getSnapshot().project as ContentProject;
    const scene = project.scenes[0]!;
    expect(scene.environmentTransform?.position).toEqual([3, 0, 4]);
    expect(scene.objects.map((object) => object.transform.position)).toEqual([
      [13, 0, 4],
      [13, 0, 14],
      [14, 0, 5],
    ]);
    expect(scene.objects[2]!.parentId).toBe(a.id);
    const saved = serializeProject(project, new Map(assets.map((asset) => [asset.id, asset.kind])));
    expect(saved.ok).toBe(true);
    if (saved.ok)
      expect(
        deserializeProject(saved.value, new Map(assets.map((asset) => [asset.id, asset.kind]))),
      ).toEqual({ ok: true, value: project });
    store.undo();
    expect(store.getSnapshot().project).toEqual(before);
    store.redo();
    expect(store.getSnapshot().project).toEqual(project);
  });
  it("snaps individual room translation and rotation to the stationary layout without disabling rotation", () => {
    const { store, a } = layout();
    expect(
      store.setTransform(a.id, {
        ...a.transform,
        position: [0.1, 0, -9.8],
        rotation: [0, Math.sin(Math.PI / 5), 0, Math.cos(Math.PI / 5)],
      }).ok,
    ).toBe(true);
    const moved = store.getSnapshot().objects.find((object) => object.id === a.id)!;
    expect(moved.transform.position).toEqual([0, 0, -10]);
    expect(moved.transform.rotation[1]).toBeCloseTo(Math.SQRT1_2);
    expect(
      store.setSelectionTransform([a.id], a.id, { ...moved.transform, scale: [2, 2, 2] }).ok,
    ).toBe(false);
  });
  it("rotates a selected layout freely on the floor and aligns newly added rooms to that layout", () => {
    const { store, a, b, first } = layout();
    const yaw = Math.PI / 4;
    expect(
      store.setSelectionTransform([first, a.id, b.id], first, {
        position: [3, 0, 4],
        rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        scale: [1, 1, 1],
      }).ok,
    ).toBe(true);
    const scene = (store.getSnapshot().project as ContentProject).scenes[0]!;
    expect(scene.objects[0]!.transform.position[0]).toBeCloseTo(3 + 10 * Math.SQRT1_2);
    expect(scene.objects[0]!.transform.position[2]).toBeCloseTo(4 - 10 * Math.SQRT1_2);
    const added = store.addObject("test-room-module-v1", [-4, 0, 11]);
    expect(added.ok).toBe(true);
    if (added.ok)
      expect(added.object.transform.rotation).toEqual(scene.environmentTransform!.rotation);
  });
  it("rejects moving a selected pair through a stationary room without changing history", () => {
    const { store, a, b } = layout();
    const before = store.getSnapshot();
    // Snapping A behind the initial room would put B inside the initial room.
    expect(
      store.setSelectionTransform([a.id, b.id], a.id, { ...a.transform, position: [0, 0, -10] }).ok,
    ).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });

  it("requires the whole room, including rotated corners, to fit on the grid", () => {
    expect(roomFitsGrid([35, 0, -35])).toBe(true);
    expect(roomFitsGrid([35.1, 0, 0])).toBe(false);
    const rotation = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] as const;
    expect(roomFitsGrid([32, 0, 32], rotation)).toBe(true);
    expect(roomFitsGrid([33, 0, 33], rotation)).toBe(false);
  });

  it("previews room movement freely but reconnects on release instead of saving gaps", () => {
    const { store, a } = layout();
    const edit = store.beginTransform(a.id);
    if (!edit.ok) throw new Error(edit.error.message);
    const preview = store.previewTransform(edit.value.token, {
      ...a.transform,
      position: [11.5, 0.2, 0],
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.value.after.position).toEqual([11.5, 0.2, 0]);
    expect(store.commitTransformEdit(edit.value.token).ok).toBe(true);
    expect(
      store.getSnapshot().objects.find((object) => object.id === a.id)!.transform.position,
    ).toEqual([10, 0, 0]);
    expect(store.setTransform(a.id, { ...a.transform, position: [0.7, 0, -9] }).ok).toBe(true);
    expect(
      store.getSnapshot().objects.find((object) => object.id === a.id)!.transform.position,
    ).toEqual([0, 0, -10]);
  });

  it("snaps a selected room when its crate is the active transform anchor", () => {
    const { store, a } = layout();
    const crate = store.addObject("test-crate-v1", [11, 0, 1], a.id);
    if (!crate.ok) throw Error(crate.error);
    const original = store.getSnapshot().project;
    expect(
      store.setSelectionTransform([a.id, crate.object.id], crate.object.id, {
        ...crate.object.transform,
        position: [-9, 0.4, 1],
      }).ok,
    ).toBe(true);
    expect(
      store.getSnapshot().objects.find((object) => object.id === a.id)!.transform.position,
    ).toEqual([-10, 0, 0]);
    expect(
      store.getSnapshot().objects.find((object) => object.id === crate.object.id)!.transform
        .position,
    ).toEqual([-9, 0, 1]);
    store.undo();
    expect(store.getSnapshot().project).toEqual(original);
  });
  it("renders unparented furnishings after deleting the initial room", () => {
    const { store, first } = layout();
    store.deleteObject(first);
    const loose = store.addObject("test-crate-v1", [-12, 0, -12]);
    if (!loose.ok) throw Error(loose.error);
    const html = renderToStaticMarkup(
      createElement(SceneTreePanel, {
        room: undefined,
        objects: store.getSnapshot().objects,
        groups: [],
        hotspots: [],
        selectedId: loose.object.id,
        onSelect() {},
        onDelete() {},
        mobileDevice: false,
        thumbnailFor: () => undefined,
        hierarchy: { rename: () => true, move() {} },
      }),
    );
    expect(html).toContain(`data-object-id="${loose.object.id}"`);
  });
  it("numbers repeated assets per type starting at two, including the initial room", () => {
    const { store, a, b } = layout();
    expect(a.name).toBe("test-room-module-v1 2");
    expect(b.name).toBe("test-room-module-v1 3");
    const first = store.addObject("test-crate-v1", [1, 0, 1]);
    const second = store.addObject("test-crate-v1", [2, 0, 2]);
    expect(first.ok && first.object.name).toBe("test-crate-v1");
    expect(second.ok && second.object.name).toBe("test-crate-v1 2");
  });
  it("deletes the initial room and its nested contents, preserving other rooms and one undo step", () => {
    const { store, a, first } = layout();
    const crate = store.addObject("test-crate-v1", [0, 0, 0], first);
    const other = store.addObject("test-crate-v1", [10, 0, 0], a.id);
    if (!crate.ok || !other.ok) throw new Error("Could not place contents");
    const before = store.getSnapshot().project;
    expect(store.deleteObject(first).ok).toBe(true);
    const scene = (store.getSnapshot().project as ContentProject).scenes[0]!;
    expect(scene.environmentVisible).toBe(false);
    expect(scene.objects.some((object) => object.id === crate.object.id)).toBe(false);
    expect(scene.objects.some((object) => object.id === other.object.id)).toBe(true);
    store.undo();
    expect(store.getSnapshot().project).toEqual(before);
    store.redo();
    expect((store.getSnapshot().project as ContentProject).scenes[0]!.environmentVisible).toBe(
      false,
    );
  });
  it("deletes the last room into an empty saveable project and permits adding a new room", () => {
    const store = createLoadedStore(assets, "test-room-v1");
    const id = store.getSnapshot().activeSceneId!;
    store.addObject("test-crate-v1", [0, 0, 0], id);
    expect(store.deleteObject(id).ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(0);
    const project = store.getSnapshot().project as ContentProject;
    const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
    const saved = serializeProject(project, kinds);
    expect(saved.ok).toBe(true);
    if (saved.ok)
      expect(deserializeProject(saved.value, kinds)).toEqual({ ok: true, value: project });
    const room = store.addObject("test-room-module-v1", [0, 0, 0]);
    expect(room.ok && room.object.name).toBe("test-room-module-v1");
  });

  it("allows a room resize preview while retaining the original authored size", () => {
    const { store, a } = layout();
    const original = store.getSnapshot().project as ContentProject;
    const scene = original.scenes[0]!;
    const resized = { ...a.transform, scale: [1.2, 1.2, 1.2] as const };
    const preview = moveSceneSelection(scene, [a.id], a.id, resized, true);
    expect(preview.ok).toBe(true);
    if (preview.ok)
      expect(preview.value.objects.find((object) => object.id === a.id)!.transform.scale).toEqual(
        resized.scale,
      );
    expect(moveSceneSelection(scene, [a.id], a.id, resized).ok).toBe(false);
    expect(store.getSnapshot().project).toBe(original);
    expect(scene.objects.find((object) => object.id === a.id)!.transform.scale).toEqual([1, 1, 1]);
  });

  it("aligns new rooms with the remaining rotated layout after deleting the initial room", () => {
    const store = createLoadedStore(assets, "test-room-v1");
    expect(store.deleteObject(store.getSnapshot().activeSceneId!).ok).toBe(true);
    const first = store.addObject("test-room-module-v1", [0, 0, 0]);
    if (!first.ok) throw new Error(first.error);
    const rotation = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] as const;
    expect(
      store.setSelectionTransform([first.object.id], first.object.id, {
        ...first.object.transform,
        rotation,
      }).ok,
    ).toBe(true);
    const next = store.addObject("test-room-module-v1", [-7, 0, 7]);
    expect(next.ok).toBe(true);
    if (next.ok)
      expect(next.object.transform.rotation).toEqual(
        store.getSnapshot().objects.find((object) => object.id === first.object.id)!.transform
          .rotation,
      );
  });
});
