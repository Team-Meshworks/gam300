import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import { validateRecoveryHistory } from "./recovery-history";
import { serializeProject } from "../shared/project/project-serialization";
import { validateProject } from "../shared/project/project-validation";
import type { CatalogueAsset } from "../shared/assets/catalogue";
import type { CameraPose } from "../shared/project/project-types";

const assets: CatalogueAsset[] = ["room", "crate"].map((id) => ({
  id,
  name: id,
  kind: id === "room" ? "environment" : "model",
  url: `${id}.glb`,
  sha256: "0".repeat(64),
  thumbnail: null,
}));
const kinds = new Map(assets.map((a) => [a.id, a.kind]));
const camera: CameraPose = { position: [1, 2, 3], rotation: [0, 0, 0, 1], fovDegrees: 45 };
function setup() {
  const store = createDocumentStore(assets);
  store.createProject("room");
  return store;
}
function views(store: ReturnType<typeof setup>) {
  return store.getSnapshot().project!.scenes[0]!.viewpoints ?? [];
}

describe("named viewpoints", () => {
  it("shares chronological history with object edits and restores original IDs and order", () => {
    const store = setup();
    expect(store.addViewpoint("Entrance", camera).ok).toBe(true);
    const first = views(store)[0]!;
    store.addObject("crate", [0, 0, 0]);
    store.addViewpoint("Overview", camera);
    store.renameViewpoint(first.id, "Door");
    store.deleteViewpoint(first.id);
    store.undo();
    expect(views(store).map((v) => v.name)).toEqual(["Door", "Overview"]);
    store.undo();
    expect(views(store)[0]).toEqual(first);
    store.undo();
    expect(views(store)).toEqual([first]);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.undo();
    expect(views(store)).toEqual([]);
    store.redo();
    expect(views(store)[0]).toEqual(first);
    expect(first.name).toBe("Entrance");
  });

  it("round-trips poses and stable IDs through files and restores mixed history after refresh", () => {
    const store = setup();
    store.addViewpoint("Entrance", camera);
    store.addObject("crate", [0, 0, 0]);
    const first = views(store)[0]!;
    store.renameViewpoint(first.id, "Door");
    store.undo();
    const json = serializeProject(store.getSnapshot().project, kinds);
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    const restored = setup();
    expect(
      restored.loadProject(
        json.value,
        kinds,
        JSON.parse(JSON.stringify(store.getRecoveryHistory())),
      ).ok,
    ).toBe(true);
    expect(views(restored)[0]).toEqual(first);
    restored.redo();
    expect(views(restored)[0]!.name).toBe("Door");
    restored.undo();
    restored.undo();
    expect(restored.getSnapshot().objects).toHaveLength(0);
    restored.undo();
    expect(views(restored)).toHaveLength(0);
    restored.redo();
    expect(views(restored)[0]).toEqual(first);
    expect(Object.isFrozen(views(restored)[0]!.camera.position)).toBe(true);
    const file = setup();
    expect(file.loadProject(json.value, kinds).ok).toBe(true);
    expect(views(file)[0]).toEqual(first);
    expect(file.getSnapshot().canUndo).toBe(false);
  });

  it("rejects invalid edits without consuming history, and only real edits clear redo", () => {
    const store = setup();
    store.addViewpoint("Entrance", camera);
    const first = views(store)[0]!;
    store.addViewpoint("Other", camera);
    store.undo();
    const before = store.getSnapshot();
    expect(store.addViewpoint(" ", camera).ok).toBe(false);
    expect(store.addViewpoint("Bad", { ...camera, fovDegrees: NaN }).ok).toBe(false);
    expect(store.renameViewpoint("missing", "New").ok).toBe(false);
    expect(store.deleteViewpoint("missing").ok).toBe(false);
    expect(store.renameViewpoint(first.id, first.name).ok).toBe(true);
    expect(store.getSnapshot()).toBe(before);
    store.renameViewpoint(first.id, "New");
    expect(store.getSnapshot().canRedo).toBe(false);
  });

  it("rejects duplicate IDs, malformed camera data and mismatched recovery metadata", () => {
    const store = setup();
    store.addViewpoint("Entrance", camera);
    const project = store.getSnapshot().project!;
    const raw = JSON.parse(JSON.stringify(project));
    raw.scenes[0].viewpoints[0].id = raw.scenes[0].id;
    expect(validateProject(raw, kinds).ok).toBe(false);
    raw.scenes[0].viewpoints[0].id = views(store)[0]!.id;
    raw.scenes[0].viewpoints[0].camera.rotation = [0, 0, 0, 0];
    expect(validateProject(raw, kinds).ok).toBe(false);
    const history = JSON.parse(JSON.stringify(store.getRecoveryHistory()));
    history.views.past = [];
    expect(validateRecoveryHistory(history, project, kinds).ok).toBe(false);
  });

  it("bounds viewpoint history and keeps older files without viewpoints readable", () => {
    const store = setup();
    const old = JSON.stringify(store.getSnapshot().project);
    store.addViewpoint("Start", camera);
    const id = views(store)[0]!.id;
    for (let i = 0; i < 105; i++) store.renameViewpoint(id, `View ${i}`);
    expect(store.getRecoveryHistory()!.past).toHaveLength(100);
    expect(store.getRecoveryHistory()!.views!.past).toHaveLength(100);
    expect(store.loadProject(old, kinds).ok).toBe(true);
    expect(views(store)).toEqual([]);
  });
});

it("reorders views in one undo step and preserves the order through recovery and file saving", () => {
  const store = setup();
  for (const name of ["A", "B", "C"]) store.addViewpoint(name, camera);
  const original = views(store);
  const before = store.getSnapshot();
  expect(store.moveViewpoint(original[0]!.id, 0).ok).toBe(true);
  expect(store.moveViewpoint(original[0]!.id, -1).ok).toBe(false);
  expect(store.moveViewpoint("missing", 1).ok).toBe(false);
  expect(store.getSnapshot()).toBe(before);
  store.moveViewpoint(original[0]!.id, 2);
  expect(views(store).map((v) => v.name)).toEqual(["B", "C", "A"]);
  expect(original.map((v) => v.name)).toEqual(["A", "B", "C"]);
  const json = serializeProject(store.getSnapshot().project, kinds);
  expect(json.ok).toBe(true);
  if (!json.ok) return;
  const restored = setup();
  expect(
    restored.loadProject(json.value, kinds, JSON.parse(JSON.stringify(store.getRecoveryHistory())))
      .ok,
  ).toBe(true);
  expect(views(restored).map((v) => v.name)).toEqual(["B", "C", "A"]);
  restored.undo();
  expect(views(restored)).toEqual(original);
  restored.redo();
  expect(views(restored).map((v) => v.name)).toEqual(["B", "C", "A"]);
  restored.undo();
  restored.moveViewpoint(original[2]!.id, 0);
  expect(restored.getSnapshot().canRedo).toBe(false);
  expect(views(restored).map((v) => v.name)).toEqual(["C", "A", "B"]);
});
