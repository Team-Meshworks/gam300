import { describe, expect, it } from "vitest";
import sample from "./fixtures/m1-project.json";
import { readOlderSceneFile } from "./legacy-scene-import";
import { deserializeProject } from "./project-deserialization";
const kinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
function older() {
  const { hotspots: _hotspots, interactions: _interactions, ...scene } = sample.scenes[0]!;
  const view = {
    id: crypto.randomUUID(),
    name: "Entrance",
    camera: { ...scene.startCamera, position: [3, 4, 5] },
  };
  return {
    ...sample,
    scenes: [
      {
        ...scene,
        environmentAssetId: null,
        viewpoints: [view],
        startViewpointId: view.id,
        startCamera: view.camera,
      },
      { ...scene, id: crypto.randomUUID(), objects: [], viewpoints: [] },
    ],
  };
}
describe("older publication project format", () => {
  it("reads an extended version 1 document while strict deserialization rejects it", () => {
    const old = older();
    const text = JSON.stringify(old);
    expect(deserializeProject(text, kinds)).toMatchObject({
      ok: false,
      error: { path: "project.scenes" },
    });
    expect(readOlderSceneFile(text, kinds)).toEqual({ ok: true, value: old });
  });

  it("rejects duplicate JSON keys in an otherwise valid older publication", () => {
    const document = JSON.stringify(older());
    const duplicate = document.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(readOlderSceneFile(duplicate, kinds)).toEqual({
      ok: false,
      error: { path: "project", message: "Project JSON contains duplicate fields" },
    });
  });

  it("rejects unknown fields and over-limit documents instead of dropping data", () => {
    const old = older();
    expect(readOlderSceneFile(JSON.stringify({ ...old, secret: "drop me" }), kinds)).toMatchObject({
      ok: false,
      error: { path: "project.secret" },
    });
    const scenes = Array.from({ length: 21 }, () => ({
      ...old.scenes[1]!,
      id: crypto.randomUUID(),
    }));
    expect(readOlderSceneFile(JSON.stringify({ ...old, scenes }), kinds)).toMatchObject({
      ok: false,
      error: { path: "project.scenes" },
    });
  });
});
