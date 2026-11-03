import { missingProjectCapabilities } from "../shared/project/project-capabilities";
import { expect, it } from "vitest";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { serializeProject } from "../shared/project/project-serialization";
import { validateRecoveryHistory } from "./recovery-history";
import { createDocumentStore } from "./document-store";

const assets: CatalogueAsset[] = ["room", "crate"].map((id) => ({
  id,
  name: id,
  kind: id === "room" ? "environment" : "model",
  url: `${id}.glb`,
  sha256: "0".repeat(64),
  thumbnail: null,
}));
const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
type Store = ReturnType<typeof createDocumentStore>;
function active(store: Store) {
  const snapshot = store.getSnapshot();
  return snapshot.project!.scenes.find((scene) => scene.id === snapshot.activeSceneId)!;
}
function setup() {
  const store = createDocumentStore(assets);
  expect(store.createProject("room").ok).toBe(true);
  const object = store.addObject("crate", [1, 0, 2]);
  if (!object.ok) throw Error(object.error);
  const hotspot = store.addHotspot(object.object.id, [0.5, 1, 0]);
  if (!hotspot.ok) throw Error(hotspot.error.message);
  expect(
    store.setInteractions([
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: hotspot.value.id },
        do: { type: "print-hi" },
      },
    ]).ok,
  ).toBe(true);
  return { store, object: object.object, hotspot: hotspot.value };
}

it("retains hotspots and rules through viewpoint upgrades, scene edits, recovery and undo", () => {
  const { store, object, hotspot } = setup();
  const original = active(store);
  expect(store.addViewpoint("Entrance", original.startCamera).ok).toBe(true);
  const first = active(store);
  expect(store.getSnapshot().project!.schemaVersion).toBe(2);
  expect(first.hotspots).toEqual([hotspot]);
  expect(first.interactions).toEqual(original.interactions);
  expect(store.createScene("Second room").ok).toBe(true);
  const secondId = active(store).id;
  expect(active(store).hotspots).toEqual([]);
  expect(active(store).interactions).toEqual([]);
  expect(store.switchScene(first.id).ok).toBe(true);
  expect(store.renameViewpoint(first.viewpoints![0]!.id, "Entry").ok).toBe(true);
  expect(store.moveScene(first.id, 1).ok).toBe(true);
  expect(store.deleteObject(object.id).ok).toBe(true);
  expect(active(store).hotspots).toEqual([]);
  expect(active(store).interactions).toEqual([]);
  store.undo();
  const beforeDeletion = store.getSnapshot().project!;
  expect(active(store).hotspots).toEqual([hotspot]);
  expect(active(store).viewpoints![0]!.name).toBe("Entry");
  expect(store.deleteScene(first.id).ok).toBe(true);
  expect(active(store).id).toBe(secondId);
  const saved = serializeProject(store.getSnapshot().project, kinds);
  if (!saved.ok) throw Error(saved.error.message);
  const recovered = createDocumentStore(assets);
  expect(
    recovered.loadProject(
      saved.value,
      kinds,
      JSON.parse(JSON.stringify(store.getRecoveryHistory())),
    ).ok,
  ).toBe(true);
  recovered.undo();
  expect(recovered.getSnapshot().project).toEqual(beforeDeletion);
  expect(active(recovered).id).toBe(first.id);
  expect(active(recovered).hotspots).toEqual([hotspot]);
  expect(active(recovered).interactions).toEqual(original.interactions);
  recovered.redo();
  expect(active(recovered).id).toBe(secondId);
});

it("allows scene and viewpoint edits while an interaction link is unfinished, but rejects saving it", () => {
  const { store, hotspot } = setup();
  const firstId = active(store).id;
  const draft = {
    when: { type: "visitor-clicks-hotspot" as const, targetHotspotId: hotspot.id },
    do: { type: "open-link" as const, url: "" },
  };
  expect(store.setInteractions([draft]).ok).toBe(true);
  expect(store.addViewpoint("Entrance", active(store).startCamera).ok).toBe(true);
  expect(store.renameScene(firstId, "Gallery").ok).toBe(true);
  expect(store.createScene("Other gallery").ok).toBe(true);
  expect(store.switchScene(firstId).ok).toBe(true);
  expect(active(store).interactions).toEqual([draft]);
  expect(serializeProject(store.getSnapshot().project, kinds).ok).toBe(false);
  expect(
    validateRecoveryHistory(store.getRecoveryHistory(), store.getSnapshot().project!, kinds).ok,
  ).toBe(true);
  expect(
    store.setInteractions([
      { ...draft, do: { type: "open-link", url: "https://example.com/exhibit" } },
    ]).ok,
  ).toBe(true);
  const saved = serializeProject(store.getSnapshot().project, kinds);
  if (!saved.ok) throw Error(saved.error.message);
  const restored = createDocumentStore(assets);
  expect(
    restored.loadProject(saved.value, kinds, JSON.parse(JSON.stringify(store.getRecoveryHistory())))
      .ok,
  ).toBe(true);
  restored.undo();
  expect(active(restored).interactions).toEqual([draft]);
  restored.redo();
  expect(serializeProject(restored.getSnapshot().project, kinds).ok).toBe(true);
});

it("retains navigation targets through rename, reorder, undo and recovery; protects referenced destinations", () => {
  const { store, hotspot } = setup();
  const firstId = active(store).id;
  expect(store.addViewpoint("Gallery detail", active(store).startCamera).ok).toBe(true);
  const viewId = active(store).viewpoints![0]!.id;
  expect(store.createScene("Next gallery").ok).toBe(true);
  const secondId = active(store).id;
  expect(store.switchScene(firstId).ok).toBe(true);
  const rules = [
    {
      when: { type: "visitor-clicks-hotspot" as const, targetHotspotId: hotspot.id },
      do: { type: "navigate-scene" as const, sceneId: secondId.toUpperCase() },
    },
    {
      when: { type: "scene-starts" as const },
      do: { type: "move-to-viewpoint" as const, viewpointId: viewId.toUpperCase() },
    },
  ];
  expect(store.setInteractions(rules).ok).toBe(true);
  store.undo();
  expect(active(store).interactions).not.toEqual(rules);
  store.redo();
  expect(active(store).interactions).toEqual(rules);
  expect(
    missingProjectCapabilities(store.getSnapshot().project!, new Set()).map(
      (issue) => issue.capability,
    ),
  ).toEqual(["multipleScenes", "interaction:navigate-scene", "interaction:move-to-viewpoint"]);
  expect(
    missingProjectCapabilities(
      store.getSnapshot().project!,
      new Set(["multipleScenes", "interaction:navigate-scene", "interaction:move-to-viewpoint"]),
    ),
  ).toEqual([]);
  expect(store.renameViewpoint(viewId, "Renamed detail").ok).toBe(true);
  expect(store.renameScene(secondId, "Renamed gallery").ok).toBe(true);
  expect(store.moveScene(secondId, 0).ok).toBe(true);
  expect(store.switchScene(firstId).ok).toBe(true);
  expect(store.deleteViewpoint(viewId).ok).toBe(false);
  expect(store.deleteScene(secondId).ok).toBe(false);
  expect(
    store.setInteractions([
      { ...rules[0]!, do: { type: "navigate-scene", sceneId: crypto.randomUUID() } },
    ]).ok,
  ).toBe(false);
  const serialized = serializeProject(store.getSnapshot().project, kinds);
  expect(serialized.ok).toBe(true);
  const reopened = createDocumentStore(assets);
  if (!serialized.ok) throw Error(serialized.error.message);
  expect(reopened.loadProject(serialized.value, kinds, store.getRecoveryHistory()).ok).toBe(true);
  expect(reopened.switchScene(firstId).ok).toBe(true);
  expect(active(reopened).interactions).toEqual(rules);
  expect(reopened.setInteractions([]).ok).toBe(true);
  expect(reopened.deleteViewpoint(viewId).ok).toBe(true);
  expect(reopened.deleteScene(secondId).ok).toBe(true);
  reopened.undo();
  reopened.undo();
  reopened.undo();
  expect(active(reopened).interactions).toEqual(rules);
});
