import type { ProjectScene } from "./project-types";
export function getStartingView(scene: Pick<ProjectScene, "viewpoints" | "startCamera">) {
  return scene.viewpoints?.find(
    (view) => JSON.stringify(view.camera) === JSON.stringify(scene.startCamera),
  );
}
export function getStartingCamera(scene: ProjectScene) {
  return scene.startCamera;
}
