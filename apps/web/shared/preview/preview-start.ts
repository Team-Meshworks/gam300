import * as THREE from "three";
import { EYE_HEIGHT, type FpsControls } from "./FpsControls";

// Enter a walkthrough where the overview meets the floor, preserving authored low views
export function standOnPreviewFloor(camera: THREE.Camera, fps: FpsControls): void {
  if (camera.position.y <= EYE_HEIGHT + 1e-4) return;
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const facing = forward.clone().setY(0);
  if (facing.lengthSq() < 1e-8) facing.set(0, 0, -1);
  const reach = -camera.position.y / forward.y;
  if (forward.y < -1e-4 && reach < 50) camera.position.addScaledVector(forward, reach);
  camera.position.y = EYE_HEIGHT;
  fps.syncFromCamera();
  fps.lookAt(camera.position.clone().add(facing));
}
