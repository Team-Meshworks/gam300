import { assert, it } from "vitest";
import { getStartingCamera, getStartingView } from "./starting-view";
import type { CameraPose, ProjectScene } from "./project-types";
const camera: CameraPose = { position: [0, 2, 4], rotation: [0, 0, 0, 1], fovDegrees: 40 };
const first = {
  id: "first",
  name: "Entrance",
  camera: { ...camera, position: [1, 2, 3] as const },
};
const second = {
  id: "second",
  name: "Overview",
  camera: { ...camera, position: [5, 6, 7] as const },
};
const scene: ProjectScene = {
  id: "scene",
  name: "World",
  environmentAssetId: null,
  objects: [],
  startCamera: camera,
  viewpoints: [first, second],
};
it("uses the first saved view by default and follows reordered views", () => {
  assert.equal(getStartingView(scene), first);
  assert.equal(getStartingCamera(scene), first.camera);
  assert.equal(getStartingCamera({ ...scene, viewpoints: [second, first] }), second.camera);
});
it("an explicit starting view takes priority over list order", () => {
  assert.equal(getStartingCamera({ ...scene, startViewpointId: second.id }), second.camera);
  assert.equal(
    getStartingCamera({ ...scene, startViewpointId: first.id, viewpoints: [second, first] }),
    first.camera,
  );
});
it("uses the saved camera when there are no viewpoints", () => {
  assert.equal(getStartingCamera({ ...scene, viewpoints: [] }), camera);
  const { viewpoints, ...legacy } = scene;
  assert.lengthOf(viewpoints!, 2);
  assert.equal(getStartingCamera(legacy), camera);
});
