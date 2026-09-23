import * as THREE from "three";

const EYE_HEIGHT = 0.9;
const WALK_SPEED = 5;
const SPRINT_SPEED = 12;
const ACCELERATION = 12;
const LOOK_SPEED = 0.002;
const MAX_PITCH = Math.PI / 2 - 0.01;

const HANDLED_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
]);

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();

export class FpsControls {
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private engaged = false;
  private readonly _euler = new THREE.Euler(0, 0, 0, "YXZ");

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    domElement.addEventListener("mousedown", this.onPointerDown);
    document.addEventListener("mousemove", this.onPointerMove);
    document.addEventListener("mouseup", this.onPointerUp);
  }

  engage(): void {
    if (this.engaged) return;
    this.engaged = true;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.dragging = false;
    this.applyRotation();
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);
  }

  lookAt(target: THREE.Vector3): void {
    if (this.camera.position.distanceToSquared(target) < 1e-8) return;
    this.camera.lookAt(target);
    this._euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this._euler.y;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this._euler.x));
    this.applyRotation();
  }

  disengage(): void {
    if (!this.engaged) return;
    this.engaged = false;
    this.dragging = false;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
  }

  dispose(): void {
    this.disengage();
    this.domElement.removeEventListener("mousedown", this.onPointerDown);
    document.removeEventListener("mousemove", this.onPointerMove);
    document.removeEventListener("mouseup", this.onPointerUp);
  }

  update(delta: number): void {
    if (!this.engaged) return;

    this.applyRotation();

    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const maxSpeed = sprint ? SPRINT_SPEED : WALK_SPEED;

    const inputZ = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const inputX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const inputY =
      (this.keys.has("Space") ? 1 : 0) -
      (this.keys.has("ControlLeft") || this.keys.has("ControlRight") ? 1 : 0);

    _forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-8) {
      _forward.set(0, 0, -1);
    } else {
      _forward.normalize();
    }

    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _right.y = 0;
    _right.normalize();

    _wish.set(0, inputY, 0).addScaledVector(_forward, inputZ).addScaledVector(_right, inputX);
    if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(maxSpeed);

    const smoothing = 1 - Math.exp(-ACCELERATION * delta);
    this.velocity.lerp(_wish, smoothing);
    this.camera.position.addScaledVector(this.velocity, delta);
    this.camera.position.y = Math.max(this.camera.position.y, EYE_HEIGHT);
  }

  private readonly onPointerDown = (event: MouseEvent) => {
    if (this.engaged && event.button === 0) {
      this.dragging = true;
    }
  };

  private readonly onPointerMove = (event: MouseEvent) => {
    if (!this.engaged || !this.dragging) return;
    this.yaw -= event.movementX * LOOK_SPEED;
    this.pitch -= event.movementY * LOOK_SPEED;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (HANDLED_KEYS.has(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (HANDLED_KEYS.has(event.code)) this.keys.delete(event.code);
  };

  private applyRotation(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }
}
