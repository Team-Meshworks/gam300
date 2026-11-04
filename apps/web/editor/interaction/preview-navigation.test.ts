import { expect, it, vi } from "vitest";
import type { CameraPose, ProjectDocument } from "../../shared/project/project-types";
import { createPreviewNavigation } from "./preview-navigation";
import { createActionRunner } from "./actionHandler";
import { createInteractionHandler } from "./interactionHandler";

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
    const navigation = { goToScene: vi.fn(() => true), goToViewpoint: vi.fn() };
    const runner = createActionRunner(navigation);
    const when =
      type === "visitor-clicks-hotspot"
        ? { type, targetHotspotId: "hotspot" }
        : type === "time-elapsed"
          ? { type, seconds: 1 }
          : { type };
    const handler = createInteractionHandler(
      [
        { when, do: { type: "navigate-scene", sceneId: "next" } },
        { when, do: { type: "move-to-viewpoint", viewpointId: "old-view" } },
      ],
      [{ id: "hotspot", objectId: "object", position: [0, 0, 0] }],
      runner,
    );
    if (type === "scene-starts") handler.sceneStarted();
    else if (type === "time-elapsed") handler.update(1);
    else handler.objectClicked("OBJECT");
    expect(navigation.goToScene).toHaveBeenCalledExactlyOnceWith("next");
    expect(navigation.goToViewpoint).not.toHaveBeenCalled();
  },
);
