import { expect, it, vi } from "vitest";
import { createDocumentStore } from "./document-store";
import { handleObjectShortcut } from "./history-shortcuts";

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
