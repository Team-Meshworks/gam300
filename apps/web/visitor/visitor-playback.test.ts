import { afterEach, expect, it } from "vitest";
import * as THREE from "three";
import { createVisitorPlayback } from "../shared/player/playback";
import type { ProjectRule } from "../shared/project/project-content";
import type { Interaction } from "../shared/project/project-types";
import { createActionRunner } from "../editor/interaction/actionHandler";
import { createInteractionHandler } from "../editor/interaction/interactionHandler";

const destination = "saved-view";
const viewpoint = {
  id: destination,
  name: "Saved view",
  camera: { position: [2, 1, 3], rotation: [0, 0, 0, 1], fovDegrees: 60 },
} as const;
const activeVisits: ReturnType<typeof createVisitorPlayback>[] = [];

afterEach(() => {
  for (const visit of activeVisits.splice(0)) visit.dispose();
  document.body.replaceChildren();
});

function visit({
  rules = [],
  interactions = [],
  navigate = () => false,
  showObject,
}: {
  rules?: readonly ProjectRule[];
  interactions?: readonly Interaction[];
  navigate?: (sceneId: string) => boolean;
  showObject?: (object: THREE.Object3D) => void;
} = {}) {
  const content = document.createElement("main");
  const owner = document.createElement("article");
  owner.dataset.ownerId = "owner";
  content.append(owner);
  document.body.append(content);
  const camera = new THREE.PerspectiveCamera();
  const object = new THREE.Group();
  const runtime = createVisitorPlayback(
    {
      id: "scene",
      name: "Test scene",
      environmentAssetId: null,
      startCamera: { position: [0, 0, 5], rotation: [0, 0, 0, 1], fovDegrees: 40 },
      objects: [],
      interactions,
      hotspots: [],
      groups: [],
      zones: [],
      viewpoints: [viewpoint],
      rules,
    },
    camera,
    { target: new THREE.Vector3(), update() {} },
    new Map([["owner", object]]),
    content,
    navigate,
    () => {},
    undefined,
    undefined,
    showObject,
  );
  activeVisits.push(runtime);
  return { runtime, owner, object, camera };
}

const sceneStart: readonly Interaction[] = [
  { when: { type: "scene-starts" }, do: { type: "navigate-scene", sceneId: "missing" } },
  { when: { type: "scene-starts" }, do: { type: "move-to-viewpoint", viewpointId: destination } },
];

it("continues ordered scene-start actions after a failure in both preview and visitor", () => {
  const unavailable = () => {
    throw new Error("Navigation service unavailable");
  };
  const views: string[] = [];
  const preview = createInteractionHandler(
    sceneStart,
    [],
    createActionRunner({
      goToScene: unavailable,
      goToViewpoint: (id) => {
        views.push(id);
      },
    }),
  );
  preview.sceneStarted();
  expect(views).toEqual([destination]);
  const { runtime, camera } = visit({ interactions: sceneStart, navigate: unavailable });
  runtime.begin();
  runtime.update(0);
  expect(camera.position.toArray()).toEqual(viewpoint.camera.position);
});

it("continues to the next scene-start rule when an action fails", () => {
  const { runtime, owner, object } = visit({
    showObject: () => {
      throw new Error("Render notification failed");
    },
    rules: [
      {
        id: "first",
        enabled: true,
        trigger: { type: "sceneStart" },
        actions: [{ type: "setVisible", objectId: "owner", visible: false }],
      },
      {
        id: "second",
        enabled: true,
        trigger: { type: "sceneStart" },
        actions: [{ type: "setVisible", objectId: "owner", visible: false }],
      },
    ],
  });
  runtime.begin();
  expect(object.visible).toBe(false);
  expect(owner.hidden).toBe(true);
});

it("keeps the current scene playable when a navigation request is rejected", () => {
  const { runtime, camera } = visit({ interactions: sceneStart });
  runtime.begin();
  runtime.update(0);
  expect(camera.position.toArray()).toEqual(viewpoint.camera.position);
});
