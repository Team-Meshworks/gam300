import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FpsControls } from "../controls/fpsControls";

export type EditorMode = "editor" | "visitor";

export interface ModeManagerState {
  mode: EditorMode;
}

const EYE_HEIGHT = 0.9;

export class ModeManager {
  private readonly camera: THREE.Camera;
  private readonly orbit: OrbitControls;
  private readonly fps: FpsControls;
  private readonly listeners = new Set<(state: ModeManagerState) => void>();
  private readonly savedPosition = new THREE.Vector3();
  private readonly savedQuaternion = new THREE.Quaternion();
  private readonly savedTarget = new THREE.Vector3();
  private state: ModeManagerState = { mode: "editor" };

  constructor(camera: THREE.Camera, orbit: OrbitControls, fps: FpsControls) {
    this.camera = camera;
    this.orbit = orbit;
    this.fps = fps;
  }

  getState(): ModeManagerState {
    return this.state;
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

  update(delta: number): void {
    if (this.state.mode === "editor") {
      this.orbit.update();
    } else {
      this.fps.update(delta);
    }
  }

  private enterVisitor(): void {
    this.savedPosition.copy(this.camera.position);
    this.savedQuaternion.copy(this.camera.quaternion);
    this.savedTarget.copy(this.orbit.target);

    this.orbit.enabled = false;
    this.state = { mode: "visitor" };

    this.camera.position.y = Math.max(this.camera.position.y, EYE_HEIGHT);
    this.fps.engage();
    this.fps.lookAt(this.savedTarget);
    this.emit();
  }

  private exitVisitor(): void {
    if (this.state.mode !== "visitor") return;
    this.fps.disengage();
    this.camera.position.copy(this.savedPosition);
    this.camera.quaternion.copy(this.savedQuaternion);
    this.orbit.target.copy(this.savedTarget);
    this.orbit.enabled = true;
    this.orbit.update();
    this.state = { mode: "editor" };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}