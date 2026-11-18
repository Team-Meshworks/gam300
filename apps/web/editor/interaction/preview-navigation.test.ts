import { expect, it, vi } from "vitest";
import type { CameraPose, ProjectDocument } from "../../shared/project/project-types";
import { createPreviewNavigation } from "./preview-navigation";
import { createActionRunner } from "./actionHandler";
import { createInteractionHandler } from "./interactionHandler";
import fixture from "../../shared/project/fixtures/m2-project.json";
import { deserializeProject } from "../../shared/project/project-deserialization";

function loadFixture() {
  const loaded = deserializeProject(
    JSON.stringify(fixture),
    new Map([
      ["test-room-v1", "environment"],
      ["test-crate-v1", "model"],
      ["demo-image-v1", "image"],
      ["demo-audio-v1", "audio"],
      ["demo-video-v1", "video"],
    ]),
  );
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

it("stops delayed scene cycles while allowing a deliberate return", () => {
  const project = loadFixture();
  const [first, second] = project.scenes;
  if (!first || !second) throw new Error("Two scenes are required");
  let activeSceneId = first.id;
  const notice = vi.fn();
  const navigation = createPreviewNavigation({
    snapshot: () => ({ project, activeSceneId }),
    switchScene(id) {
      activeSceneId = id;
      return { ok: true };
    },
    showCamera: vi.fn(),
    notice,
  });
  const enter = (destination: string) =>
    createInteractionHandler(
      [
        {
          when: { type: "time-elapsed", seconds: 1 },
          do: { type: "navigate-scene", sceneId: destination },
        },
        {
          when: { type: "visitor-clicks-hotspot", targetHotspotId: "return" },
          do: { type: "navigate-scene", sceneId: destination },
        },
      ],
      [{ id: "return", objectId: "door", position: [0, 0, 0] }],
      createActionRunner(navigation),
      navigation.beginEvent,
    );
  navigation.start();
  enter(second.id).update(1);
  expect(activeSceneId).toBe(second.id);
  const secondVisit = enter(first.id);
  secondVisit.update(1);
  expect(activeSceneId).toBe(second.id);
  expect(notice).toHaveBeenCalledOnce();
  secondVisit.objectClicked("door");
  expect(activeSceneId).toBe(first.id);
  navigation.end();
});

it("navigates by stable IDs, resolves local viewpoints, stops scene-start loops and restores the author scene", () => {
  const camera: CameraPose = { position: [2, 3, 4], rotation: [0, 0, 0, 1], fovDegrees: 45 };
  const scene = (id: string) => ({
    id,
    name: "Same name",
    environmentAssetId: "room",
    startCamera: camera,
    objects: [],
    hotspots: [],
    interactions: [],
    groups: [],
    zones: [],
    rules: [],
    viewpoints: [{ id: `view-${id}`, name: "Same name", camera }],
  });
  const project: ProjectDocument = {
    schemaVersion: 2,
    projectId: "project",
    title: "Navigation",
    scenes: [scene("a"), scene("b")],
  };
  let activeSceneId = "a";
  const showCamera = vi.fn();
  const notice = vi.fn();
  const navigation = createPreviewNavigation({
    snapshot: () => ({ project, activeSceneId }),
    switchScene(id) {
      activeSceneId = id;
      return { ok: true };
    },
    showCamera,
    notice,
  });
  expect(navigation.goToScene("b")).toBe(false);
  navigation.start();
  navigation.goToViewpoint("VIEW-A");
  expect(showCamera).toHaveBeenCalledExactlyOnceWith(camera);
  navigation.goToViewpoint("view-b");
  expect(showCamera).toHaveBeenCalledTimes(1);
  expect(navigation.goToScene("missing")).toBe(false);
  expect(navigation.goToScene("B")).toBe(true);
  expect(activeSceneId).toBe("b");
  expect(navigation.goToScene("a")).toBe(false);
  expect(notice).toHaveBeenCalledOnce();
  navigation.beginEvent();
  expect(navigation.goToScene("a")).toBe(true);
  navigation.beginEvent();
  expect(navigation.goToScene("b")).toBe(true);
  navigation.end();
  expect(activeSceneId).toBe("a");
  expect(project.scenes[0]!.interactions).toEqual([]);
});

it.each(["scene-starts", "time-elapsed", "visitor-clicks-hotspot"] as const)(
  "stops the source scene's remaining %s actions after navigation",
  (type) => {
    const project = loadFixture();
    const [first, next] = project.scenes;
    if (!first || !next) throw new Error("Expected two scenes");
    let activeSceneId = first.id;
    const navigation = createPreviewNavigation({
      snapshot: () => ({ project, activeSceneId }),
      switchScene(id) {
        activeSceneId = id;
        return { ok: true };
      },
      showCamera: vi.fn(),
      notice: vi.fn(),
    });
    navigation.start();
    const viewpoint = vi.spyOn(navigation, "goToViewpoint");
    const runner = createActionRunner(navigation);
    const when =
      type === "visitor-clicks-hotspot"
        ? { type, targetHotspotId: "hotspot" }
        : type === "time-elapsed"
          ? { type, seconds: 1 }
          : { type };
    const handler = createInteractionHandler(
      [
        { when, do: { type: "navigate-scene", sceneId: next.id } },
        { when, do: { type: "move-to-viewpoint", viewpointId: "old-view" } },
      ],
      [{ id: "hotspot", objectId: "object", position: [0, 0, 0] }],
      runner,
    );
    if (type === "scene-starts") handler.sceneStarted();
    else if (type === "time-elapsed") handler.update(1);
    else handler.objectClicked("OBJECT");
    expect(activeSceneId).toBe(next.id);
    expect(viewpoint).not.toHaveBeenCalled();
  },
);
