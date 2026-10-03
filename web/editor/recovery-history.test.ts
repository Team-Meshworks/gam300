import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import { validateRecoveryHistory } from "./recovery-history";
import { serializeProject } from "../shared/project/project-serialization";
import type { CatalogueAsset } from "../shared/assets/catalogue";

const assets: CatalogueAsset[] = [
  {
    id: "room",
    kind: "environment",
    name: "Room",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "crate",
    kind: "model",
    name: "Crate",
    url: "crate.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];
const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
function setup() {
  const store = createDocumentStore(assets);
  expect(store.createProject("room").ok).toBe(true);
  store.addObject("crate", [0, 0, 0]);
  return store;
}
function capture(store: ReturnType<typeof setup>) {
  return JSON.parse(
    JSON.stringify({ project: store.getSnapshot().project, history: store.getRecoveryHistory() }),
  );
}
function reopen(saved: ReturnType<typeof capture>) {
  const store = createDocumentStore(assets);
  expect(store.loadProject(JSON.stringify(saved.project), kinds, saved.history).ok).toBe(true);
  return store;
}

describe("local recovery history", () => {
  it("restores both stacks, ordering and IDs across repeated refreshes", () => {
    const store = setup();
    const id = store.getSnapshot().objects[0]!.id;
    store.setTransform(id, {
      position: [4, 2, 1],
      rotation: [0, Math.sin(0.3), 0, Math.cos(0.3)],
      scale: [2, 3, 4],
    });
    store.duplicateObject(id);
    const duplicate = store.getSnapshot().objects[1]!;
    store.deleteObject(id);
    store.undo();
    const restored = reopen(capture(store));
    expect(restored.getSnapshot().canUndo).toBe(true);
    expect(restored.getSnapshot().canRedo).toBe(true);
    restored.redo();
    expect(restored.getSnapshot().objects).toEqual([duplicate]);
    restored.undo();
    restored.undo();
    expect(restored.getSnapshot().objects.map((o) => o.id)).toEqual([id]);
    const again = reopen(capture(restored));
    again.redo();
    expect(again.getSnapshot().objects[1]).toEqual(duplicate);
    again.redo();
    expect(again.getSnapshot().objects).toEqual([duplicate]);
    again.undo();
    again.undo();
    again.undo();
    expect(again.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 0]);
    again.undo();
    expect(again.getSnapshot().objects).toEqual([]);
  });

  it("preserves an all-undone redo stack and branches correctly after recovery", () => {
    const store = setup();
    store.undo();
    const restored = reopen(capture(store));
    expect(restored.getSnapshot().canUndo).toBe(false);
    expect(restored.getSnapshot().canRedo).toBe(true);
    restored.addObject("crate", [3, 0, 0]);
    expect(restored.getSnapshot().canRedo).toBe(false);
    expect(reopen(capture(restored)).getSnapshot().canRedo).toBe(false);
  });

  it("leaves exported files history-free and opening a file resets history", () => {
    const store = setup();
    const saved = serializeProject(store.getSnapshot().project, kinds);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value).not.toContain('"history"');
    expect(store.loadProject(saved.value, kinds).ok).toBe(true);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().canRedo).toBe(false);
  });

  it("captures a stable scene/history pair and excludes previews", () => {
    const store = setup();
    const id = store.getSnapshot().objects[0]!.id;
    const saved = { project: store.getSnapshot().project, history: store.getRecoveryHistory() };
    const session = store.beginTransform(id);
    if (!session.ok) throw new Error("begin failed");
    store.previewTransform(session.value.token, {
      position: [10, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(store.getRecoveryHistory()).toEqual(saved.history);
    store.commitTransformEdit(session.value.token);
    const restored = reopen(JSON.parse(JSON.stringify(saved)));
    expect(restored.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 0]);
    restored.undo();
    expect(restored.getSnapshot().objects).toEqual([]);
  });

  it.each(["version", "project", "scene", "current", "duplicate", "asset", "limit", "transform"])(
    "rejects invalid %s without replacing the live document or history",
    (bad) => {
      const store = setup();
      store.duplicateObject(store.getSnapshot().objects[0]!.id);
      const saved = capture(store);
      if (bad === "version") saved.history.version = 99;
      if (bad === "project") saved.history.projectId = crypto.randomUUID();
      if (bad === "scene") saved.history.sceneId = crypto.randomUUID();
      if (bad === "current") saved.history.current = [];
      if (bad === "duplicate") saved.history.past[0].push(saved.history.past[0][0]);
      if (bad === "asset") saved.history.past[0][0].assetId = "missing";
      if (bad === "limit") saved.history.past = Array(101).fill([]);
      if (bad === "transform") saved.history.past[0][0].transform.scale = [0, 1, 1];
      const initial = store.getSnapshot();
      expect(store.loadProject(JSON.stringify(saved.project), kinds, saved.history).ok).toBe(false);
      expect(store.getSnapshot()).toBe(initial);
      expect(validateRecoveryHistory(saved.history, saved.project, kinds).ok).toBe(false);
    },
  );

  it("retains the existing 100-command bound across recovery", () => {
    const store = setup();
    const id = store.getSnapshot().objects[0]!.id;
    for (let x = 1; x <= 110; x++)
      store.setTransform(id, { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const restored = reopen(capture(store));
    for (let i = 0; i < 100; i++) restored.undo();
    expect(restored.getSnapshot().objects[0]!.transform.position).toEqual([10, 0, 0]);
    expect(restored.getSnapshot().canUndo).toBe(false);
  });
});
