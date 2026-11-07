import { expect, it, vi } from "vitest";
import { createDocumentStore } from "./document-store";
import { handleObjectShortcut } from "./history-shortcuts";
import m1 from "../shared/project/fixtures/m1-project.json";
import type { ContentObject } from "../shared/project/project-content";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";

const projectAssets: CatalogueAsset[] = ["test-room-v1", "test-crate-v1"].map((id) => ({
  id,
  name: id,
  kind: id === "test-room-v1" ? "environment" : "model",
  url: `${id}.glb`,
  sha256: "0".repeat(64),
  thumbnail: null,
}));
const camera = { position: [1, 2, 3] as const, rotation: [0, 0, 0, 1] as const, fovDegrees: 45 };
function legacyProject() {
  const store = createDocumentStore(projectAssets);
  expect(
    store.loadProject(
      JSON.stringify(m1),
      new Map(projectAssets.map((asset) => [asset.id, asset.kind])),
    ).ok,
  ).toBe(true);
  expect(store.getSnapshot().project?.schemaVersion).toBe(1);
  return store;
}

it("normalizes a v1 clipboard object when a viewpoint upgrades the destination", () => {
  const store = legacyProject();
  const source = store.getSnapshot().objects[0]!;
  expect(store.copyObject(source.id).ok).toBe(true);
  expect(store.addViewpoint("Entrance", camera).ok).toBe(true);
  expect(store.getSnapshot().project?.schemaVersion).toBe(2);
  const result = store.pasteObject();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value).toMatchObject({ parentId: null, visible: true, components: [] });
  const pasted = store.getSnapshot().project;
  store.undo();
  expect(store.getSnapshot().objects).toHaveLength(m1.scenes[0]!.objects.length);
  store.redo();
  expect(store.getSnapshot().project).toEqual(pasted);
});

it("rejects v2 clipboard content in v1 without losing it or changing undo history", () => {
  const store = legacyProject();
  expect(store.addViewpoint("Entrance", camera).ok).toBe(true);
  const object = store.getSnapshot().objects[0]!;
  const text = {
    id: crypto.randomUUID(),
    type: "text" as const,
    runs: [{ text: "A story", marks: [] }],
    caption: "",
  };
  expect(
    store.editExhibit(object.id, object, {
      name: object.name,
      transform: object.transform,
      components: [text],
    }).ok,
  ).toBe(true);
  expect(store.copyObject(object.id).ok).toBe(true);
  store.undo();
  store.undo();
  const before = store.getSnapshot();
  expect(before.project?.schemaVersion).toBe(1);
  expect(store.pasteObject().ok).toBe(false);
  expect(store.getSnapshot()).toBe(before);
  store.redo();
  store.redo();
  const result = store.pasteObject();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect((result.value as ContentObject).components).toEqual([{ ...text, id: expect.any(String) }]);
  expect((result.value as ContentObject).components[0]!.id).not.toBe(text.id);
});

it("rejects v2 appearance when pasting into a v1 project", () => {
  const store = legacyProject();
  expect(store.addViewpoint("Entrance", camera).ok).toBe(true);
  const object = store.getSnapshot().objects[0]!;
  expect(store.setAppearance(object.id, { color: "#bd2949", material: "wood" }).ok).toBe(true);
  expect(store.copyObject(object.id).ok).toBe(true);
  store.undo();
  store.undo();
  const before = store.getSnapshot();
  expect(before.project?.schemaVersion).toBe(1);
  expect(store.pasteObject().ok).toBe(false);
  expect(store.getSnapshot()).toBe(before);
});

it("rejects copied canonical rules in v1 even when the object has no components", () => {
  const store = legacyProject();
  expect(store.addViewpoint("Entrance", camera).ok).toBe(true);
  const document = structuredClone(
    store.getSnapshot().project!,
  ) as import("../shared/project/project-content").ContentProject;
  const source = document.scenes[0]!.objects[0]!;
  const rule = {
    id: crypto.randomUUID(),
    enabled: true,
    trigger: { type: "click" as const, targetId: source.id },
    actions: [{ type: "setVisible" as const, objectId: source.id, visible: false }],
  };
  const withRule = {
    ...document,
    scenes: document.scenes.map((scene, index) =>
      index === 0 ? { ...scene, rules: [rule] } : scene,
    ),
  };
  const history = structuredClone(store.getRecoveryHistory()!);
  const recovery = { ...history, documents: { ...history.documents!, current: withRule } };
  expect(
    store.loadProject(
      JSON.stringify(withRule),
      new Map(projectAssets.map((asset) => [asset.id, asset.kind])),
      recovery,
    ).ok,
  ).toBe(true);
  expect(store.copyObject(source.id).ok).toBe(true);
  store.undo();
  const before = store.getSnapshot();
  expect(before.project?.schemaVersion).toBe(1);
  expect(store.pasteObject().ok).toBe(false);
  expect(store.getSnapshot()).toBe(before);
  store.redo();
  const result = store.pasteObject();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const project = store.getSnapshot().project;
  if (project?.schemaVersion !== 2) throw new Error("Expected v2 project");
  expect(project.scenes[0]!.rules).toContainEqual({
    ...rule,
    id: expect.any(String),
    trigger: { type: "click", targetId: result.value.id },
    actions: [{ type: "setVisible", objectId: result.value.id, visible: false }],
  });
});

function setup() {
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
  store.addObject("crate", [1, 2, 3]);
  return store;
}

it("copies a committed snapshot, preserving rotation and scale, with stable redo IDs", () => {
  const store = setup();
  const id = store.getSnapshot().objects[0]!.id;
  store.setTransform(id, { position: [1, 2, 3], rotation: [0, 1, 0, 0], scale: [2, 3, 4] });
  store.undo();
  const before = store.getSnapshot();
  store.copyObject(id);
  expect(store.getSnapshot()).toBe(before); // Copy doesn't clear redo or publish an edit.
  store.redo();
  store.copyObject(id);
  store.deleteObject(id);
  const result = store.pasteObject();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.id).not.toBe(id);
  expect(result.value.id[14]).toBe("4");
  expect(result.value.transform).toEqual({
    position: [1.5, 2, 3.5],
    rotation: [0, 1, 0, 0],
    scale: [2, 3, 4],
  });
  store.undo();
  expect(store.getSnapshot().objects).toHaveLength(0);
  store.redo();
  expect(store.getSnapshot().objects).toEqual([result.value]);
  store.pasteObject();
  expect(store.getSnapshot().objects[1]!.transform.position).toEqual([2, 2, 4]);
});

it("duplicates in one step, preserves its source and branches after undo", () => {
  const store = setup();
  const original = store.getSnapshot().objects[0]!;
  store.duplicateObject(original.id);
  const duplicate = store.getSnapshot().objects[1]!;
  expect(duplicate.id).not.toBe(original.id);
  expect(duplicate.id[14]).toBe("4");
  expect(store.getSnapshot().objects[0]).toBe(original);
  for (let i = 0; i < 3; i++) {
    store.undo();
    expect(store.getSnapshot().objects).toEqual([original]);
    store.redo();
    expect(store.getSnapshot().objects).toEqual([original, duplicate]);
  }
  store.undo();
  store.duplicateObject(original.id);
  expect(store.getSnapshot().canRedo).toBe(false);
  expect(store.getSnapshot().objects[1]!.id).not.toBe(duplicate.id);
});

it("rejects missing sources, empty clipboard, out-of-bounds copies and the object limit", () => {
  const store = setup();
  const initial = store.getSnapshot();
  expect(store.pasteObject().ok).toBe(false);
  expect(store.copyObject("missing").ok).toBe(false);
  expect(store.duplicateObject("missing").ok).toBe(false);
  expect(store.getSnapshot()).toBe(initial);
  const id = initial.objects[0]!.id;
  store.setTransform(id, { ...initial.objects[0]!.transform, position: [10000, 0, 0] });
  const edge = store.getSnapshot();
  expect(store.duplicateObject(id).ok).toBe(false);
  expect(store.getSnapshot()).toBe(edge);
  store.undo();
  for (let i = 1; i < 200; i++) store.addObject("crate", [0, 0, 0]);
  const full = store.getSnapshot();
  store.copyObject(id);
  expect(store.pasteObject().ok).toBe(false);
  expect(store.duplicateObject(id).ok).toBe(false);
  expect(store.getSnapshot()).toBe(full);
});

it.each(["c", "v", "d"])(
  "handles Ctrl+%s and leaves text fields, composition and repeat alone",
  (key) => {
    const actions = { copy: vi.fn(), paste: vi.fn(), duplicate: vi.fn() };
    const event = {
      key,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
    };
    handleObjectShortcut(event, actions, true);
    handleObjectShortcut({ ...event, isComposing: true }, actions, false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    handleObjectShortcut({ ...event, repeat: true }, actions, false);
    expect(actions.copy).not.toHaveBeenCalled();
    expect(actions.paste).not.toHaveBeenCalled();
    expect(actions.duplicate).not.toHaveBeenCalled();
    handleObjectShortcut(event, actions, false);
    const action = key === "c" ? actions.copy : key === "v" ? actions.paste : actions.duplicate;
    expect(action).toHaveBeenCalledOnce();
    handleObjectShortcut({ ...event, ctrlKey: false, metaKey: true }, actions, false);
    expect(action).toHaveBeenCalledTimes(2);
  },
);
