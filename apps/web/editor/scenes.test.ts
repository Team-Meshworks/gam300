import { assert, it } from "vitest";
import { createDocumentStore } from "./document-store";
import type { CatalogueAsset } from "../shared/assets/catalogue";
const assets: CatalogueAsset[] = [
  {
    id: "crate",
    name: "Crate",
    kind: "model",
    url: "crate.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];
const kinds = new Map(assets.map((a) => [a.id, a.kind]));
function setup() {
  const store = createDocumentStore(assets);
  assert.isTrue(store.createScene("World A").ok);
  return store;
}
it("keeps whole scenes separate and switches without an undo step", () => {
  const s = setup(),
    a = s.getSnapshot().activeSceneId!;
  assert.isNull(s.getSnapshot().project!.scenes[0]!.environmentAssetId);
  s.addObject("crate", [1, 2, 3]);
  s.addViewpoint("Entrance", s.getSnapshot().project!.scenes[0]!.startCamera);
  const original = s.getSnapshot().project!.scenes[0]!;
  s.createScene("World B");
  const b = s.getSnapshot().activeSceneId!;
  assert.lengthOf(s.getSnapshot().objects, 0);
  s.addObject("crate", [9, 0, 0]);
  s.switchScene(a);
  assert.deepEqual(s.getSnapshot().objects, original.objects);
  s.undo();
  assert.equal(s.getSnapshot().activeSceneId, b);
  assert.lengthOf(s.getSnapshot().objects, 0);
  s.redo();
  assert.deepEqual(s.getSnapshot().objects[0]!.transform.position, [9, 0, 0]);
  assert.deepEqual(s.getSnapshot().project!.scenes[0], original);
});
it("undoes scene creation, names and order with stable IDs", () => {
  const s = setup(),
    a = s.getSnapshot().activeSceneId!;
  s.createScene("World B");
  const b = s.getSnapshot().activeSceneId!;
  s.renameScene(b, "Renamed world");
  s.moveScene(b, 0);
  assert.deepEqual(
    s.getSnapshot().project!.scenes.map((s) => s.id),
    [b, a],
  );
  s.undo();
  assert.deepEqual(
    s.getSnapshot().project!.scenes.map((s) => s.id),
    [a, b],
  );
  s.undo();
  assert.equal(s.getSnapshot().project!.scenes[1]!.name, "World B");
  s.undo();
  assert.lengthOf(s.getSnapshot().project!.scenes, 1);
  assert.equal(s.getSnapshot().activeSceneId, a);
  s.redo();
  s.redo();
  s.redo();
  assert.equal(s.getSnapshot().project!.scenes[0]!.name, "Renamed world");
});
it("round trips scene data and recovers shared undo/redo with the active scene", () => {
  const s = setup(),
    a = s.getSnapshot().activeSceneId!;
  s.addObject("crate", [1, 0, 0]);
  s.createScene("World B");
  const b = s.getSnapshot().activeSceneId!;
  s.addObject("crate", [2, 0, 0]);
  s.moveScene(b, 0);
  s.undo();
  s.switchScene(a);
  const json = JSON.stringify(s.getSnapshot().project),
    history = s.getRecoveryHistory();
  const recovered = createDocumentStore(assets);
  assert.isTrue(recovered.loadProject(json, kinds, JSON.parse(JSON.stringify(history))).ok);
  assert.equal(recovered.getSnapshot().activeSceneId, a);
  recovered.redo();
  assert.equal(recovered.getSnapshot().project!.scenes[0]!.id, b);
  recovered.undo();
  recovered.undo();
  assert.equal(recovered.getSnapshot().activeSceneId, b);
  assert.lengthOf(recovered.getSnapshot().objects, 0);
  assert.lengthOf(recovered.getSnapshot().project!.scenes[0]!.objects, 1);
  const reopened = createDocumentStore(assets);
  assert.isTrue(reopened.loadProject(json, kinds).ok);
  assert.deepEqual(reopened.getSnapshot().project, JSON.parse(json));
  assert.isFalse(reopened.getSnapshot().canUndo);
});
it("rejects invalid scene edits and cancels previews when switching", () => {
  const s = setup(),
    a = s.getSnapshot().activeSceneId!;
  s.createScene("B");
  const added = s.addObject("crate", [0, 0, 0]);
  if (!added.ok) throw Error(added.error);
  assert.isTrue(s.beginTransform(added.object.id).ok);
  s.switchScene(a);
  assert.isNull(s.getTransformEdit());
  const before = s.getSnapshot();
  assert.isFalse(s.renameScene(a, " ").ok);
  assert.isFalse(s.switchScene("missing").ok);
  assert.isFalse(s.moveScene(a, 9).ok);
  assert.isFalse(s.setEnvironment("crate").ok);
  assert.equal(s.getSnapshot(), before);
  for (let i = 2; i < 20; i++) assert.isTrue(s.createScene(`World ${i}`).ok);
  const full = s.getSnapshot();
  assert.isFalse(s.createScene("Overflow").ok);
  assert.equal(s.getSnapshot(), full);
});
it("rejects recovery history for a missing scene", () => {
  const s = setup();
  s.createScene("B");
  const history = JSON.parse(JSON.stringify(s.getRecoveryHistory()));
  history.documents.activeSceneId = crypto.randomUUID();
  const target = setup(),
    before = target.getSnapshot();
  assert.isFalse(target.loadProject(JSON.stringify(s.getSnapshot().project), kinds, history).ok);
  assert.equal(target.getSnapshot(), before);
});
it("rejects incomplete legacy history for a multi-scene project", () => {
  const s = setup();
  s.createScene("B");
  const history = JSON.parse(JSON.stringify(s.getRecoveryHistory()));
  delete history.documents;
  const target = setup();
  assert.isFalse(target.loadProject(JSON.stringify(s.getSnapshot().project), kinds, history).ok);
});
it("persists a chosen starting viewpoint and undoes it through shared history", () => {
  const s = setup();
  const scene = s.getSnapshot().project!.scenes[0]!;
  const camera = { ...scene.startCamera, position: [3, 4, 5] as const };
  s.addViewpoint("Arrival", camera);
  const id = s.getSnapshot().project!.scenes[0]!.viewpoints![0]!.id;
  assert.isTrue(s.setStartingViewpoint(id).ok);
  assert.deepEqual(s.getSnapshot().project!.scenes[0]!.startCamera, camera);
  s.undo();
  assert.isUndefined(s.getSnapshot().project!.scenes[0]!.startViewpointId);
  s.redo();
  assert.equal(s.getSnapshot().project!.scenes[0]!.startViewpointId, id);
  const recovered = createDocumentStore(assets);
  assert.isTrue(
    recovered.loadProject(
      JSON.stringify(s.getSnapshot().project),
      kinds,
      JSON.parse(JSON.stringify(s.getRecoveryHistory())),
    ).ok,
  );
  recovered.undo();
  assert.isUndefined(recovered.getSnapshot().project!.scenes[0]!.startViewpointId);
  recovered.redo();
  assert.equal(recovered.getSnapshot().project!.scenes[0]!.startViewpointId, id);
  s.renameViewpoint(id, "Entrance");
  assert.equal(s.getSnapshot().project!.scenes[0]!.startViewpointId, id);
  s.deleteViewpoint(id);
  assert.isUndefined(s.getSnapshot().project!.scenes[0]!.startViewpointId);
  assert.deepEqual(s.getSnapshot().project!.scenes[0]!.startCamera, camera);
  s.undo();
  assert.equal(s.getSnapshot().project!.scenes[0]!.startViewpointId, id);
});
it("deletes an entire scene atomically and restores its contents and order after recovery", () => {
  const s = setup(),
    a = s.getSnapshot().activeSceneId!;
  s.createScene("B");
  const b = s.getSnapshot().activeSceneId!;
  s.addObject("crate", [1, 0, 0]);
  s.addViewpoint("Arrival", s.getSnapshot().project!.scenes[1]!.startCamera);
  s.setStartingViewpoint(s.getSnapshot().project!.scenes[1]!.viewpoints![0]!.id);
  const before = s.getSnapshot().project;
  assert.isTrue(s.deleteScene(b).ok);
  assert.equal(s.getSnapshot().activeSceneId, a);
  assert.lengthOf(s.getSnapshot().project!.scenes, 1);
  const recovered = createDocumentStore(assets);
  assert.isTrue(
    recovered.loadProject(
      JSON.stringify(s.getSnapshot().project),
      kinds,
      JSON.parse(JSON.stringify(s.getRecoveryHistory())),
    ).ok,
  );
  recovered.undo();
  assert.deepEqual(recovered.getSnapshot().project, before);
  assert.equal(recovered.getSnapshot().activeSceneId, b);
  recovered.redo();
  assert.lengthOf(recovered.getSnapshot().project!.scenes, 1);
  assert.isFalse(recovered.deleteScene(a).ok);
  assert.isFalse(recovered.deleteScene("missing").ok);
});
it("rejects foreign or mismatched starting viewpoints without replacing the project", () => {
  const s = setup();
  s.addViewpoint("Arrival", s.getSnapshot().project!.scenes[0]!.startCamera);
  const id = s.getSnapshot().project!.scenes[0]!.viewpoints![0]!.id;
  s.createScene("B");
  const before = s.getSnapshot();
  assert.isFalse(s.setStartingViewpoint(id).ok);
  assert.equal(s.getSnapshot(), before);
  const raw = JSON.parse(JSON.stringify(before.project));
  raw.scenes[1].startViewpointId = id;
  assert.isFalse(s.loadProject(JSON.stringify(raw), kinds).ok);
  raw.scenes[1].startViewpointId = undefined;
  raw.scenes[0].startViewpointId = id;
  raw.scenes[0].startCamera.position = [99, 0, 0];
  assert.isFalse(s.loadProject(JSON.stringify(raw), kinds).ok);
  assert.equal(s.getSnapshot(), before);
});
