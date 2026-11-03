import { describe, expect, it } from "vitest";
import sample from "./fixtures/m1-project.json";
import { importOlderSceneFile, readOlderSceneFile } from "./legacy-scene-import";
import { deserializeProject } from "./project-deserialization";
import { serializeProject } from "./project-serialization";
const kinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
function older() {
  const scene = structuredClone(sample.scenes[0]!);
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
describe("explicit older scene import", () => {
  it("keeps strict Open unchanged and requires environment choices without mutating the input", () => {
    const old = older(),
      text = JSON.stringify(old);
    expect(deserializeProject(text, kinds).ok).toBe(false);
    expect(importOlderSceneFile(text, kinds).ok).toBe(false);
    const result = importOlderSceneFile(text, kinds, { [old.scenes[0]!.id]: "test-room-v1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.message);
    expect(result.value.schemaVersion).toBe(2);
    expect(result.value.scenes.map((s) => s.id)).toEqual(old.scenes.map((s) => s.id));
    expect(result.value.scenes[0]!.startCamera).toEqual(old.scenes[0]!.viewpoints[0]!.camera);
    expect(result.value.scenes[0]).not.toHaveProperty("startViewpointId");
    expect(result.value.scenes[0]!.objects[0]).toMatchObject({
      ...old.scenes[0]!.objects[0],
      parentId: null,
      visible: true,
      components: [],
    });
    expect(serializeProject(result.value, kinds).ok).toBe(true);
    expect(JSON.stringify(old)).toBe(text);
  });
  it("preserves first-view fallback as the authored start camera", () => {
    const old = older();
    delete (old.scenes[0] as { startViewpointId?: string }).startViewpointId;
    old.scenes[0]!.startCamera = sample.scenes[0]!.startCamera;
    const result = importOlderSceneFile(JSON.stringify(old), kinds, {
      [old.scenes[0]!.id]: "test-room-v1",
    });
    expect(result.ok && result.value.scenes[0]!.startCamera).toEqual(
      old.scenes[0]!.viewpoints[0]!.camera,
    );
  });
  it("rejects unknown fields, duplicate JSON keys and over-limit documents instead of dropping data", () => {
    expect(readOlderSceneFile('{"schemaVersion":1,"schemaVersion":1}', kinds).ok).toBe(false);
    const old = older();
    expect(importOlderSceneFile(JSON.stringify({ ...old, secret: "drop me" }), kinds).ok).toBe(
      false,
    );
    const scenes = Array.from({ length: 17 }, () => ({
      ...sample.scenes[0]!,
      id: crypto.randomUUID(),
      objects: [],
    }));
    expect(importOlderSceneFile(JSON.stringify({ ...sample, scenes }), kinds).ok).toBe(false);
  });
});
