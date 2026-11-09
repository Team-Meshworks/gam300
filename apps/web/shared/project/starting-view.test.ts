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
  environmentAssetId: "room",
  objects: [],
  hotspots: [],
  interactions: [],
  startCamera: camera,
  viewpoints: [first, second],
};
it("uses the authored starting camera independently of viewpoint order", () => {
  assert.equal(getStartingView(scene), undefined);
  assert.equal(getStartingCamera(scene), camera);
  assert.equal(getStartingCamera({ ...scene, viewpoints: [second, first] }), camera);
});
it("identifies a saved view with the same pose without adding a wire-format field", () => {
  assert.equal(getStartingView({ ...scene, startCamera: second.camera }), second);
  assert.equal(getStartingCamera({ ...scene, startCamera: second.camera }), second.camera);
});
it("uses the saved camera when there are no viewpoints", () => {
  assert.equal(getStartingCamera({ ...scene, viewpoints: [] }), camera);
  const { viewpoints, ...legacy } = scene;
  assert.lengthOf(viewpoints!, 2);
  assert.equal(getStartingCamera(legacy), camera);
});
