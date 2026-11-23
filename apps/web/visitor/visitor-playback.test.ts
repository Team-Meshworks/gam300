import { expect, it } from "vitest";
import * as THREE from "three";
import { createVisitorPlayback } from "../shared/player/playback";

it("skips the rest of a failed scene-start rule and continues to the next rule", () => {
  const viewpoint = {
    id: "saved-view",
    name: "Saved view",
    camera: { position: [2, 1, 3], rotation: [0, 0, 0, 1], fovDegrees: 60 },
  } as const;
  const content = document.createElement("main");
  const owner = document.createElement("article");
  owner.dataset.ownerId = "owner";
  content.append(owner);
  document.body.append(content);
  const camera = new THREE.PerspectiveCamera();
  const object = new THREE.Group();
  const locked = new THREE.Group();
  Object.freeze(locked);
  const runtime = createVisitorPlayback(
    {
      id: "scene",
      name: "Test scene",
      environmentAssetId: null,
      startCamera: { position: [0, 0, 5], rotation: [0, 0, 0, 1], fovDegrees: 40 },
      objects: [],
      interactions: [],
      hotspots: [],
      groups: [],
      zones: [],
      viewpoints: [viewpoint],
      rules: [
        {
          id: "first",
          enabled: true,
          trigger: { type: "sceneStart" },
          actions: [
            { type: "setVisible", objectId: "owner", visible: false },
            { type: "setVisible", objectId: "locked", visible: false },
            { type: "setVisible", objectId: "owner", visible: true },
          ],
        },
        {
          id: "second",
          enabled: true,
          trigger: { type: "sceneStart" },
          actions: [{ type: "moveCamera", viewpointId: viewpoint.id, durationSeconds: 0 }],
        },
      ],
    },
    camera,
    { target: new THREE.Vector3(), update() {} },
    new Map([
      ["owner", object],
      ["locked", locked],
    ]),
    content,
    () => false,
    () => {},
  );

  try {
    runtime.begin();
    runtime.update(0);
    expect(locked.visible).toBe(true);
    expect(object.visible).toBe(false);
    expect(owner.hidden).toBe(true);
    expect(camera.position.toArray()).toEqual(viewpoint.camera.position);
  } finally {
    runtime.dispose();
    content.remove();
  }
});
