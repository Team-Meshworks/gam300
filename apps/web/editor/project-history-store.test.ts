import { expect, it } from "vitest";
import documentFixture from "./fixtures/asset-pipeline-document-history.json";
import viewpointFixture from "./fixtures/asset-pipeline-view-history.json";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { deserializeProject } from "../shared/project/project-deserialization";
import { createDocumentStore } from "./document-store";
import { validateRecoveryHistory } from "./recovery-history";

const assets: CatalogueAsset[] = ["room", "crate"].map((id) => ({
  id,
  name: id,
  kind: id === "room" ? "environment" : "model",
  url: `${id}.glb`,
  sha256: "0".repeat(64),
  thumbnail: null,
}));
const kinds = new Map(assets.map((a) => [a.id, a.kind]));
type Store = ReturnType<typeof createDocumentStore>;
function checked<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}
function setup(fixture: { document: unknown; history: unknown } = documentFixture) {
  const store = createDocumentStore(assets);
  checked(store.loadProject(JSON.stringify(fixture.document), kinds, fixture.history));
  return store;
}
function active(store: Store) {
  const snapshot = store.getSnapshot();
  return snapshot.project!.scenes.find((s) => s.id === snapshot.activeSceneId)!;
}
function reopen(store: Store) {
  const document = store.getSnapshot().project!;
  const history = JSON.parse(JSON.stringify(store.getRecoveryHistory()));
  checked(validateRecoveryHistory(history, document, kinds));
  return setup({ document, history });
}
function normalize(raw: unknown) {
  return checked(deserializeProject(JSON.stringify(raw), kinds)).value;
}

it("restores asset-pipeline scene reordering and deletion, including the active scene", () => {
  let store = setup();
  const original = store.getSnapshot();
  expect(original.activeSceneId).toBe(original.project!.scenes[1]!.id);
  expect(original.objects).toBe(active(store).objects);
  for (const expected of documentFixture.history.documents.future) {
    store.redo();
    expect(store.getSnapshot().project).toEqual(normalize(expected.project));
    expect(store.getSnapshot().activeSceneId).toBe(expected.activeSceneId);
    store = reopen(store);
    expect(store.getSnapshot().activeSceneId).toBe(expected.activeSceneId);
  }
  expect(store.getSnapshot().project!.scenes).toHaveLength(1);
  store.undo();
  store.undo();
  expect(store.getSnapshot().project).toEqual(original.project);
  expect(store.getSnapshot().activeSceneId).toBe(original.activeSceneId);
});

it("mixes recovered scene/viewpoint edits with hotspot, rule, transform and deletion commands", () => {
  let store = setup();
  const original = store.getSnapshot();
  const activeId = original.activeSceneId!;
  const otherScene = original.project!.scenes[0]!;
  const object = original.objects[0]!;
  const states = [{ project: original.project!, activeSceneId: activeId }];
  const record = () =>
    states.push({
      project: store.getSnapshot().project!,
      activeSceneId: store.getSnapshot().activeSceneId!,
    });
  const hotspot = checked(store.addHotspot(object.id)).value;
  expect(store.getSnapshot().canRedo).toBe(false);
  record();
  checked(
    store.setInteractions([
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspot.id },
        do: { type: "print-hi" },
      },
    ]),
  );
  record();
  checked(store.setTransform(object.id, { ...object.transform, position: [12, 1, 0] }));
  record();
  checked(store.deleteObject(object.id));
  record();
  expect(active(store).objects).toEqual([]);
  expect(active(store).hotspots).toEqual([]);
  expect(active(store).interactions).toEqual([]);
  expect(store.getSnapshot().project!.scenes[0]).toBe(otherScene);
  const history = store.getRecoveryHistory();
  checked(store.switchScene(otherScene.id));
  expect(store.getRecoveryHistory()!.documents!.past).toEqual(history!.documents!.past);
  expect(store.getSnapshot().objects).toBe(otherScene.objects);
  expect(store.getRecoveryHistory()!.documents!.activeSceneId).toBe(otherScene.id);
  // A reload persists the last viewed scene as the current state. Redo back to the
  // saved tip restores that view, matching asset-pipeline's snapshot semantics.
  states[states.length - 1] = {
    project: store.getSnapshot().project!,
    activeSceneId: otherScene.id,
  };
  store = reopen(store);

  // Undo returns to the scene where the command happened, even after a scene switch/reload.
  const expectedUndo = [
    ...states.slice(0, -1).reverse(),
    ...documentFixture.history.documents.past.map((entry) => ({
      ...entry,
      project: normalize(entry.project),
    })),
  ];
  for (const expected of expectedUndo) {
    store.undo();
    expect(store.getSnapshot().project).toEqual(expected.project);
    expect(store.getSnapshot().activeSceneId).toBe(expected.activeSceneId);
    store = reopen(store);
  }
  expect(store.getSnapshot().canUndo).toBe(false);
  for (const expected of [...expectedUndo.slice(0, -1).reverse(), states.at(-1)!]) {
    store.redo();
    expect(store.getSnapshot().project).toEqual(expected.project);
    expect(store.getSnapshot().activeSceneId).toBe(expected.activeSceneId);
    store = reopen(store);
  }
  expect(store.getSnapshot().canRedo).toBe(false);
});

it("upgrades viewpoint-only recovery to full documents without losing view edits", () => {
  const store = setup(viewpointFixture);
  const original = store.getSnapshot().project!;
  expect(store.getRecoveryHistory()!.documents).toBeDefined();
  store.undo();
  const current = store.getSnapshot().project!;
  if (current.schemaVersion !== 2) throw new Error("Expected a v2 document");
  expect(current.scenes[0]!.viewpoints).toEqual([]);
  const again = reopen(store);
  again.redo();
  expect(again.getSnapshot().project).toEqual(original);
});

it("promotes both grid stacks before room creation and never borrows later attachments", () => {
  let store = createDocumentStore(assets);
  const object = checked(store.addObject("crate", [1, 0, 0])).object;
  store.undo();
  checked(store.createProject("room"));
  const room = store.getSnapshot().project!;
  store = reopen(store);
  store.redo();
  const hotspot = checked(store.addHotspot(object.id)).value;
  checked(
    store.setInteractions([
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspot.id },
        do: { type: "print-hi" },
      },
    ]),
  );
  store.undo();
  store.undo();
  store.undo();
  expect(store.getSnapshot().project).toEqual(room);
  expect(store.getSnapshot().activeSceneId).toBe(room.scenes[0]!.id);
  store = reopen(store);
  store.redo();
  store.redo();
  store.redo();
  expect(active(store).hotspots[0]!.id).toBe(hotspot.id);
  expect(active(store).objects[0]!.id).toBe(object.id);
});

it("rejects damaged document history without replacing a preview or undo stack", () => {
  const store = setup();
  const object = store.getSnapshot().objects[0]!;
  const session = checked(store.beginTransform(object.id)).value;
  const before = store.getSnapshot();
  const history = JSON.parse(JSON.stringify(store.getRecoveryHistory()));
  history.documents.future[0].activeSceneId = crypto.randomUUID();
  expect(store.loadProject(JSON.stringify(before.project), kinds, history).ok).toBe(false);
  expect(store.getSnapshot()).toBe(before);
  expect(store.getTransformEdit()).toBe(session);
  expect(store.getSnapshot().canRedo).toBe(true);
});
