import { describe, expect, it } from "vitest";
import sample from "./fixtures/m1-project.json";
import { readOlderSceneFile } from "./legacy-scene-import";
import { deserializeProject } from "./project-deserialization";
const kinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
function older() {
  const scene = {
    ...structuredClone(sample.scenes[0]!),
    hotspots: undefined,
    interactions: undefined,
  };
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
    expect(deserializeProject(text, kinds).ok).toBe(false);
    const result = readOlderSceneFile(text, kinds);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.message);
    expect(result.value.scenes.map((s) => s.id)).toEqual(old.scenes.map((s) => s.id));
    expect(result.value.scenes[0]!.startCamera).toEqual(old.scenes[0]!.viewpoints[0]!.camera);
    expect(result.value.scenes[0]!.objects).toEqual(old.scenes[0]!.objects);
  });
  it("rejects unknown fields, duplicate JSON keys and over-limit documents instead of dropping data", () => {
    expect(readOlderSceneFile('{"schemaVersion":1,"schemaVersion":1}', kinds).ok).toBe(false);
    const old = older();
    expect(readOlderSceneFile(JSON.stringify({ ...old, secret: "drop me" }), kinds).ok).toBe(false);
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
