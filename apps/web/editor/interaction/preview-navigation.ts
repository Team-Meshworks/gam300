import type { CameraPose, ProjectDocument } from "../../shared/project/project-types";

// Navigation changes the viewed scene/camera, never the authored document or undo history.
export function createPreviewNavigation(host: {
  snapshot(): { project: ProjectDocument | null; activeSceneId: string | null };
  switchScene(id: string): { ok: boolean };
  showCamera(pose: CameraPose): void;
  notice(message: string): void;
}) {
  let origin: string | null = null;
  const visited = new Set<string>();
  function beginEvent() {
    visited.clear();
    const id = host.snapshot().activeSceneId;
    if (id) visited.add(id.toLowerCase());
  }
  return {
    beginEvent,
    start() {
      origin = host.snapshot().activeSceneId;
      beginEvent();
    },
    end() {
      if (origin) host.switchScene(origin);
      origin = null;
      visited.clear();
    },
    goToScene(id: string): boolean {
      if (!origin) return false;
      const { project, activeSceneId } = host.snapshot();
      const target = project?.scenes.find((scene) => scene.id.toLowerCase() === id.toLowerCase());
      if (!target || target.id === activeSceneId) return false;
      if (visited.has(target.id.toLowerCase())) {
        host.notice("Navigation stopped: scene-start interactions form a loop.");
        return false;
      }
      visited.add(target.id.toLowerCase());
      return host.switchScene(target.id).ok;
    },
    goToViewpoint(id: string) {
      if (!origin) return;
      const { project, activeSceneId } = host.snapshot();
      const scene = project?.scenes.find((entry) => entry.id === activeSceneId);
      const view = scene?.viewpoints?.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
      if (view) host.showCamera(view.camera);
    },
  };
}
