import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EYE_HEIGHT, type FpsControls } from "../controls/fpsControls";
import { standOnPreviewFloor } from "../../shared/preview/preview-start";

// Wider than the saved 40° lens while walking, the narrow view made people feel sick
const WALKING_FOV = 70;

export type EditorMode = "editor" | "visitor";
// First person walks while editing, third person is the orbit camera with the camera tools
export type CameraView = "first" | "third";

export interface ModeManagerState {
  mode: EditorMode;
  view: CameraView;
  // Mouse is locked to the scene for looking around
  captured: boolean;
  // False when the browser wont lock the mouse, then you drag to look instead
  canCapture: boolean;
}

export class ModeManager {
  private readonly camera: THREE.Camera;
  private orbit: OrbitControls;
  private readonly fps: FpsControls;
  private readonly listeners = new Set<(state: ModeManagerState) => void>();
  private readonly savedPosition = new THREE.Vector3();
  private readonly savedQuaternion = new THREE.Quaternion();
  private readonly savedTarget = new THREE.Vector3();
  private readonly previewPosition = new THREE.Vector3();
  private readonly previewQuaternion = new THREE.Quaternion();
  private previewFov: number | undefined;
  // Walking swaps in its own lens, third person goes back to this saved one
  private lensFov: number | undefined;
  private state: ModeManagerState;

  constructor(camera: THREE.Camera, orbit: OrbitControls, fps: FpsControls) {
    this.camera = camera;
    this.orbit = orbit;
    this.fps = fps;
    this.state = { mode: "editor", view: "first", captured: false, canCapture: fps.canCapture() };
    fps.onCaptureChange = () =>
      this.setState({ captured: fps.isCaptured(), canCapture: fps.canCapture() });
  }

  getState(): ModeManagerState {
    return this.state;
  }

  // Orbit only drive the camera in the editor's third person view
  usesOrbit(): boolean {
    return this.state.mode === "editor" && this.state.view === "third";
  }

  setOrbitControls(orbit: OrbitControls): void {
    this.orbit = orbit;
  }

  subscribe(listener: (state: ModeManagerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setMode(mode: EditorMode): void {
    if (mode === this.state.mode) return;
    if (mode === "visitor") {
      this.enterVisitor();
    } else {
      this.exitVisitor();
    }
  }

  setView(view: CameraView): void {
    if (view === this.state.view) return;
    // While previewing only remember it, leaving the preview puts it into effect
    if (this.state.mode === "editor") {
      if (view === "first") this.startWalking(true);
      else this.stopWalking();
    }
    this.setState({ view });
  }

  initializeView(view: CameraView): void {
    if (view === "first" && this.state.mode === "editor") {
      this.startWalking(true);
    }
    this.setState({ view });
  }

  // A saved camera just replaced the pose, so first person carries on from exactly there.
  // Standing on the floor is only for switching views. Third person returns to this pose too
  resetView(): void {
    if (this.state.view === "first" && this.state.mode === "editor" && this.fps.isEngaged()) {
      this.savedPosition.copy(this.camera.position);
      this.savedQuaternion.copy(this.camera.quaternion);
      this.savedTarget.copy(this.orbit.target);
      this.fps.syncFromCamera();
      // The saved camera brought its own lens, walking still uses the wider one
      if (this.camera instanceof THREE.PerspectiveCamera) this.lensFov = this.camera.fov;
      this.setFov(WALKING_FOV);
    }
  }

  update(delta: number): void {
    if (this.usesOrbit()) {
      this.orbit.update();
    } else {
      this.fps.update(delta);
    }
  }

  private enterVisitor(): void {
    this.previewPosition.copy(this.camera.position);
    this.previewQuaternion.copy(this.camera.quaternion);
    // Viewpoints in Preview can change the lens, so leaving puts the editor's back
    if (this.camera instanceof THREE.PerspectiveCamera) this.previewFov = this.camera.fov;
    // A visitor walks on the floor and cant fly, so preview starts standing there too
    if (this.state.view === "third") this.startWalking(true);
    else this.standOnFloor();
    this.fps.setFlightAllowed(false);
    this.setState({ mode: "visitor" });
  }

  private exitVisitor(): void {
    if (this.state.mode !== "visitor") return;
    this.fps.setFlightAllowed(true);
    if (this.camera instanceof THREE.PerspectiveCamera && this.previewFov !== undefined) {
      this.camera.fov = this.previewFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(this.previewPosition);
    this.camera.quaternion.copy(this.previewQuaternion);
    if (this.state.view === "third") this.stopWalking();
    else this.fps.sync();
    this.setState({ mode: "editor" });
  }

  // From the orbit camera. The editor stand you on the floor where the camera was looking,
  // preview keep the camera where it is (flying) like before
  private startWalking(onFloor: boolean): void {
    if (this.camera instanceof THREE.PerspectiveCamera) this.lensFov = this.camera.fov;
    this.setFov(WALKING_FOV);
    this.savedPosition.copy(this.camera.position);
    this.savedQuaternion.copy(this.camera.quaternion);
    this.savedTarget.copy(this.orbit.target);
    this.orbit.enabled = false;

    if (onFloor) {
      const facing = this.savedTarget.clone().sub(this.savedPosition).setY(0);
      if (facing.lengthSq() < 1e-8) facing.set(0, 0, -1);
      this.camera.position.set(this.savedTarget.x, EYE_HEIGHT, this.savedTarget.z);
      this.fps.engage();
      this.fps.lookAt(this.camera.position.clone().add(facing));
    } else {
      this.camera.position.y = Math.max(this.camera.position.y, EYE_HEIGHT);
      this.fps.engage();
      this.fps.lookAt(this.savedTarget);
    }
  }

  // Flying in first person, then stand where the view meets the floor. Looking at the sky or
  // far off drops straight down instead
  private standOnFloor(): void {
    standOnPreviewFloor(this.camera, this.fps);
  }

  private setFov(fov: number | undefined): void {
    if (fov === undefined || !(this.camera instanceof THREE.PerspectiveCamera)) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private stopWalking(): void {
    this.setFov(this.lensFov);
    this.fps.disengage();
    this.camera.position.copy(this.savedPosition);
    this.camera.quaternion.copy(this.savedQuaternion);
    this.orbit.target.copy(this.savedTarget);
    this.orbit.enabled = true;
    this.orbit.update();
  }

  private setState(next: Partial<ModeManagerState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }
}
