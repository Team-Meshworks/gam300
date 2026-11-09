import { createLoadedStore } from "../tests/project-store-fixture";
import { describe, expect, it } from "vitest";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import type { Interaction, ProjectDocument } from "../shared/project/project-types";
import { validateProject } from "../shared/project/project-validation";
import { createDocumentStore } from "./document-store";
import { validateRecoveryHistory } from "./recovery-history";

const assets: CatalogueAsset[] = [
  {
    id: "room",
    name: "Room",
    kind: "environment",
    url: "room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "crate",
    name: "Crate",
    kind: "model",
    url: "crate.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];
const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
type Store = ReturnType<typeof createDocumentStore>;
const scene = (store: Store) => store.getSnapshot().project!.scenes[0]!;
const startRule: Interaction = { when: { type: "scene-starts" }, do: { type: "print-hi" } };
const clickRule = (targetHotspotId: string): Interaction => ({
  when: { type: "visitor-clicks-hotspot", targetHotspotId },
  do: { type: "print-hi" },
});

function setup(version: 1 | 2 = 1) {
  const store = createLoadedStore(assets, "room");
  if (version === 2) {
    const project = store.getSnapshot().project!;
    const first = { ...scene(store), groups: [], zones: [], viewpoints: [], rules: [] };
    expect(
      store.loadProject(
        JSON.stringify({
          ...project,
          schemaVersion: 2,
          scenes: [first, { ...first, id: crypto.randomUUID(), name: "Other scene" }],
        }),
        kinds,
      ).ok,
    ).toBe(true);
  }
  return store;
}

function addObject(store: Store) {
  const result = store.addObject("crate", [0, 0, 0]);
  if (!result.ok) throw new Error(result.error);
  return result.object;
}
function addHotspot(store: Store, id: string) {
  const result = store.addHotspot(id, [0.25, 0, -0.5]);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function assertRecoverable(store: Store) {
  const project = store.getSnapshot().project!;
  expect(validateProject(project, kinds).ok).toBe(true);
  const history = JSON.parse(JSON.stringify(store.getRecoveryHistory()));
  expect(validateRecoveryHistory(history, project, kinds).ok).toBe(true);
  const reopened = createDocumentStore(assets);
  expect(reopened.loadProject(JSON.stringify(project), kinds, history).ok).toBe(true);
  expect(reopened.getSnapshot().project).toEqual(project);
  return reopened;
}

describe.each([1, 2] as const)("v%i interaction undo and recovery", (version) => {
  it("shares one reversible order across placement, hotspots, rules and transforms", () => {
    const store = setup(version);
    const states: ProjectDocument[] = [store.getSnapshot().project!];
    const object = addObject(store);
    states.push(store.getSnapshot().project!);
    const hotspot = addHotspot(store, object.id);
    states.push(store.getSnapshot().project!);
    expect(store.setInteractions([clickRule(hotspot.id), startRule]).ok).toBe(true);
    states.push(store.getSnapshot().project!);
    expect(store.setTransform(object.id, { ...object.transform, position: [2, 1, 0] }).ok).toBe(
      true,
    );
    states.push(store.getSnapshot().project!);
    expect(store.setInteractions([startRule, clickRule(hotspot.id)]).ok).toBe(true);
    states.push(store.getSnapshot().project!);
    expect(store.setInteractions([startRule]).ok).toBe(true);
    states.push(store.getSnapshot().project!);

    let recovered = assertRecoverable(store);
    for (let i = states.length - 2; i >= 0; i--) {
      store.undo();
      recovered.undo();
      expect(store.getSnapshot().project).toEqual(states[i]);
      expect(recovered.getSnapshot().project).toEqual(states[i]);
      recovered = assertRecoverable(recovered);
    }
    expect(store.getSnapshot().canUndo).toBe(false);
    for (const expected of states.slice(1)) {
      store.redo();
      recovered.redo();
      expect(store.getSnapshot().project).toEqual(expected);
      expect(recovered.getSnapshot().project).toEqual(expected);
      recovered = assertRecoverable(recovered);
    }
    expect(store.getSnapshot().canRedo).toBe(false);
  });

  it.each(["object", "hotspot"])(
    "deletes a %s and restores attachments, spelling and order atomically",
    (target) => {
      const store = setup(version);
      const a = addObject(store);
      const b = addObject(store);
      const c = addObject(store);
      const h1 = addHotspot(store, a.id);
      const h2 = addHotspot(store, b.id);
      const h3 = addHotspot(store, c.id);
      expect(
        store.setInteractions([clickRule(h1.id), clickRule(h2.id), clickRule(h3.id), startRule]).ok,
      ).toBe(true);
      // Imports permit UUID references with different casing. Cleanup must use the same identity rules.
      const imported = JSON.parse(JSON.stringify(store.getSnapshot().project));
      imported.scenes[0].hotspots[0].objectId = a.id.toUpperCase();
      imported.scenes[0].interactions[0].when.targetHotspotId = h1.id.toUpperCase();
      expect(store.loadProject(JSON.stringify(imported), kinds).ok).toBe(true);
      const before = store.getSnapshot().project!;
      let notifications = 0;
      store.subscribe(() => {
        notifications++;
        expect(validateProject(store.getSnapshot().project, kinds).ok).toBe(true);
      });
      const result =
        target === "object"
          ? store.deleteObject(a.id.toUpperCase())
          : store.deleteHotspot(h1.id.toUpperCase());
      expect(result.ok).toBe(true);
      expect(notifications).toBe(1);
      expect(scene(store).hotspots.map((h) => h.id)).toEqual([h2.id, h3.id]);
      expect(scene(store).interactions).toEqual([clickRule(h2.id), clickRule(h3.id), startRule]);
      const after = store.getSnapshot().project!;
      const reopened = assertRecoverable(store);
      for (const current of [store, reopened]) {
        current.undo();
        expect(current.getSnapshot().project).toEqual(before);
        current.redo();
        expect(current.getSnapshot().project).toEqual(after);
      }
      expect(before.scenes[0]!.objects).toHaveLength(3);
      expect(before.scenes[0]!.hotspots).toHaveLength(3);
      expect(Object.isFrozen(scene(reopened).interactions[0]!.when)).toBe(true);
    },
  );

  it("keeps redo for unchanged or rejected rules and discards it for a new attachment edit", () => {
    const store = setup(version);
    const object = addObject(store);
    const hotspot = addHotspot(store, object.id);
    expect(store.setInteractions([clickRule(hotspot.id)]).ok).toBe(true);
    store.undo();
    const before = store.getSnapshot();
    const history = store.getRecoveryHistory();
    expect(store.setInteractions([]).ok).toBe(true);
    expect(store.setInteractions(Array(201).fill(startRule)).ok).toBe(false);
    expect(store.setInteractions([clickRule(crypto.randomUUID())]).ok).toBe(false);
    expect(
      store.setInteractions([
        { when: { type: "time-elapsed", seconds: -1 }, do: { type: "print-hi" } },
      ]).ok,
    ).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.getRecoveryHistory()).toEqual(history);
    addHotspot(store, addObject(store).id);
    expect(store.getSnapshot().canRedo).toBe(false);
    assertRecoverable(store);
  });
});

it("migrates legacy object-only undo and redo without losing the room", () => {
  const store = setup();
  const object = addObject(store);
  expect(store.setTransform(object.id, { ...object.transform, position: [3, 0, 0] }).ok).toBe(true);
  store.undo();
  const history = store.getRecoveryHistory()!;
  const legacy = {
    version: 1,
    projectId: history.projectId,
    sceneId: history.sceneId,
    current: history.current,
    past: history.past,
    future: history.future,
  };
  const reopened = createDocumentStore(assets);
  expect(reopened.loadProject(JSON.stringify(store.getSnapshot().project), kinds, legacy).ok).toBe(
    true,
  );
  reopened.redo();
  expect(reopened.getSnapshot().objects[0]!.transform.position).toEqual([3, 0, 0]);
  reopened.undo();
  reopened.undo();
  expect(scene(reopened).objects).toEqual([]);
  expect(scene(reopened).environmentAssetId).toBe("room");
  assertRecoverable(reopened);
});

it.each(["current hotspots", "current rules", "past orphan", "future orphan", "unknown field"])(
  "rejects damaged %s atomically",
  (damage) => {
    const store = setup();
    const object = addObject(store);
    const hotspot = addHotspot(store, object.id);
    expect(store.setInteractions([clickRule(hotspot.id)]).ok).toBe(true);
    store.undo();
    const history = JSON.parse(JSON.stringify(store.getRecoveryHistory()));
    if (damage === "current hotspots") history.documents.current.scenes[0].hotspots = [];
    if (damage === "current rules") history.documents.current.scenes[0].interactions = [startRule];
    if (damage === "past orphan")
      history.documents.past[0].project.scenes[0].hotspots = [
        { ...hotspot, objectId: crypto.randomUUID() },
      ];
    if (damage === "future orphan") history.documents.future[0].project.scenes[0].objects = [];
    if (damage === "unknown field") history.documents.past[0].unexpected = "Injected";
    const before = store.getSnapshot();
    const previousHistory = store.getRecoveryHistory();
    expect(store.loadProject(JSON.stringify(before.project), kinds, history).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.getRecoveryHistory()).toEqual(previousHistory);
  },
);
