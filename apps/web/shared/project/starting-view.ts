import type { ProjectScene } from "./project-types";

export function getStartingView(scene: Pick<ProjectScene, "viewpoints" | "startViewpointId">) {
  return (
    scene.viewpoints?.find((view) => view.id === scene.startViewpointId) ?? scene.viewpoints?.[0]
  );
}

export function getStartingCamera(scene: ProjectScene) {
  return getStartingView(scene)?.camera ?? scene.startCamera;
}
