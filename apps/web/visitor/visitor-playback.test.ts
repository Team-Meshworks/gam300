import { expect, it, vi } from "vitest";
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

it("fires a visitor-touch rule when the visitor reaches the hotspot owner's object", () => {
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  const content = document.createElement("main");
  document.body.append(content);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0.9, 0);
  const owner = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.y = 0.5;
  owner.add(mesh);
  const runtime = createVisitorPlayback(
    {
      id: "scene",
      name: "Test scene",
      environmentAssetId: null,
      startCamera: { position: [0, 0.9, 0], rotation: [0, 0, 0, 1], fovDegrees: 40 },
      objects: [],
      interactions: [
        {
          when: { type: "visitor-touch", targetHotspotId: "hotspot" },
          do: { type: "print-hi" },
        },
      ],
      hotspots: [{ id: "hotspot", objectId: "owner", position: [0, 0, 0] }],
      groups: [],
      zones: [],
      viewpoints: [],
      rules: [],
    },
    camera,
    { target: new THREE.Vector3(), update() {} },
    new Map([["owner", owner]]),
    content,
    () => false,
    () => {},
  );

  try {
    runtime.begin();
    runtime.update(0.016);
    expect(alert).toHaveBeenCalledTimes(1);

    camera.position.set(5, 0.9, 0);
    runtime.update(0.016);
    camera.position.set(0, 0.9, 0);
    runtime.update(0.016);
    expect(alert).toHaveBeenCalledTimes(2);
  } finally {
    runtime.dispose();
    alert.mockRestore();
    content.remove();
  }
});
