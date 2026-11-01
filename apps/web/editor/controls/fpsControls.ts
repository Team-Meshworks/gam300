import * as THREE from "three";
import { isTextEditingTarget } from "../history-shortcuts";

export const EYE_HEIGHT = 0.9;
const WALK_SPEED = 5;
const SPRINT_SPEED = 12;
const ACCELERATION = 60;
const GRAVITY = 20;
const JUMP_SPEED = 6;
// Two Space presses this close together turn flying on or off, like Minecraft creative
const DOUBLE_TAP_MS = 300;
const LOOK_SPEED = 0.002;
const MAX_PITCH = Math.PI / 2 - 0.01;
const PHYSICS_DT = 1 / 240;

// Ctrl is left out on purpose, Ctrl+W closes the tab and Ctrl+D/Z are editor shortcuts
const HANDLED_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);

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
  private flying = false;
  private lastSpace = -Infinity;
  private captured = false;
  // Embedded browsers can refuse the lock for good, then dragging is how you look around
  private lockable: boolean;
  // Alt let go of the mouse, so letting go of Alt should take it back
  private altFreed = false;
  // Turning a held object uses the mouse, so the camera doesnt look around meanwhile
  private lookHeld = false;
  private readonly _euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly physicsPosition = new THREE.Vector3();
  private readonly previousPhysics = new THREE.Vector3();
  private accumulated = 0;
  onCaptureChange: () => void = () => {};

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.lockable = typeof domElement.requestPointerLock === "function";
    domElement.addEventListener("mousedown", this.onPointerDown);
    document.addEventListener("mousemove", this.onPointerMove);
    document.addEventListener("mouseup", this.onPointerUp);
    document.addEventListener("pointerlockchange", this.onLockChange);
  }

  engage(): void {
    if (this.engaged) return;
    this.engaged = true;
    this.keys.clear();
    this.dragging = false;
    this.sync();
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);
    addEventListener("blur", this.clearInput);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  // Pick up from wherever the camera is now. Starting in the air means flying, so nothing drops
  sync(): void {
    this.velocity.set(0, 0, 0);
    this.physicsPosition.copy(this.camera.position);
    this.previousPhysics.copy(this.camera.position);
    this.accumulated = 0;
    this.flying = this.camera.position.y > EYE_HEIGHT + 1e-4;
    this._euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this._euler.y;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this._euler.x));
    this.applyRotation();
  }

  lookAt(target: THREE.Vector3): void {
    if (this.camera.position.distanceToSquared(target) < 1e-8) return;
    this.camera.lookAt(target);
    this._euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this._euler.y;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this._euler.x));
    this.applyRotation();
  }

  // A plain left click on the scene grabs the mouse instead of doing anything else
  wantsCapture(event: MouseEvent): boolean {
    return (
      this.engaged &&
      !this.captured &&
      !event.altKey &&
      event.button === 0 &&
      (!(event instanceof PointerEvent) || event.pointerType === "mouse") &&
      this.lockable
    );
  }

  isCaptured(): boolean {
    return this.captured;
  }

  canCapture(): boolean {
    return this.lockable;
  }

  holdLook(held: boolean): void {
    this.lookHeld = held;
  }

  disengage(): void {
    if (!this.engaged) return;
    this.engaged = false;
    this.dragging = false;
    this.altFreed = false;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    if (this.captured) document.exitPointerLock();
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("blur", this.clearInput);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  dispose(): void {
    this.disengage();
    this.domElement.removeEventListener("mousedown", this.onPointerDown);
    document.removeEventListener("mousemove", this.onPointerMove);
    document.removeEventListener("mouseup", this.onPointerUp);
    document.removeEventListener("pointerlockchange", this.onLockChange);
  }

  update(delta: number): void {
    if (!this.engaged) return;

    this.applyRotation();

    this.accumulated += Math.min(delta, 0.25);
    while (this.accumulated >= PHYSICS_DT) {
      this.previousPhysics.copy(this.physicsPosition);
      this.step(PHYSICS_DT);
      this.accumulated -= PHYSICS_DT;
    }
    this.camera.position
      .copy(this.previousPhysics)
      .lerp(this.physicsPosition, this.accumulated / PHYSICS_DT);
  }

  private step(delta: number): void {
    const shift = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const space = this.keys.has("Space");
    // Shift is sprint on the ground and going down while flying
    const maxSpeed = shift && !this.flying ? SPRINT_SPEED : WALK_SPEED;

    const inputZ = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const inputX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);

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

    _wish.set(0, 0, 0).addScaledVector(_forward, inputZ).addScaledVector(_right, inputX);
    if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(maxSpeed);

    const smoothing = 1 - Math.exp(-ACCELERATION * delta);
    const previous = this.velocity.clone();
    if (this.flying) {
      _wish.y = ((space ? 1 : 0) - (shift ? 1 : 0)) * WALK_SPEED;
      this.velocity.lerp(_wish, smoothing);
    } else {
      // Only the sideways part eases in, up and down is jumping and gravity
      let fall = this.velocity.y - GRAVITY * delta;
      if (space && this.onFloor()) fall = JUMP_SPEED;
      this.velocity.lerp(_wish, smoothing);
      this.velocity.y = fall;
    }
    this.physicsPosition.addScaledVector(previous.lerp(this.velocity, 0.5), delta);
    if (this.physicsPosition.y <= EYE_HEIGHT) {
      this.physicsPosition.y = EYE_HEIGHT;
      this.velocity.y = Math.max(this.velocity.y, 0);
      // Touching the floor stops flying, same as Minecraft
      this.flying = false;
    }
  }

  private onFloor(): boolean {
    return this.physicsPosition.y <= EYE_HEIGHT + 1e-4;
  }

  private capture(): void {
    // Some browsers return nothing, others a promise that rejects when the lock is refused
    Promise.resolve(this.domElement.requestPointerLock()).catch((error: unknown) => {
      // Chrome refuses for a moment after Esc, any other refusal mean this page can never lock
      if (error instanceof DOMException && error.name !== "SecurityError") {
        this.lockable = false;
        this.onCaptureChange();
      }
    });
  }

  private readonly onPointerDown = (event: MouseEvent) => {
    if (!this.engaged || event.button !== 0) return;
    if (this.wantsCapture(event)) this.capture();
    // Without the lock (touch, Alt held, or refused), dragging still turns the camera
    if (!this.captured) this.dragging = true;
  };

  private readonly onPointerMove = (event: MouseEvent) => {
    if (!this.engaged || this.lookHeld || (!this.captured && !this.dragging)) return;
    this.yaw -= event.movementX * LOOK_SPEED;
    this.pitch -= event.movementY * LOOK_SPEED;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };

  private readonly onLockChange = () => {
    const captured = document.pointerLockElement === this.domElement;
    if (captured === this.captured) return;
    this.captured = captured;
    this.dragging = false;
    this.onCaptureChange();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      // Stops Windows from jumping to the browser menu when Alt is let go
      event.preventDefault();
      // Ask the browser, the lock change event can arrive after a quick Alt press
      if (document.pointerLockElement === this.domElement && !event.repeat) {
        this.altFreed = true;
        document.exitPointerLock();
      }
      return;
    }
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.composedPath().some(isTextEditingTarget) ||
      (event.target instanceof Element && event.target.closest("button, summary, dialog[open]"))
    )
      return;
    if (!HANDLED_KEYS.has(event.code)) return;
    event.preventDefault();
    if (event.code === "Space" && !event.repeat) {
      if (event.timeStamp - this.lastSpace < DOUBLE_TAP_MS) {
        this.flying = !this.flying;
        this.velocity.y = 0;
        this.lastSpace = -Infinity;
      } else {
        this.lastSpace = event.timeStamp;
      }
    }
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      event.preventDefault();
      if (!this.altFreed) return;
      this.altFreed = false;
      // Clicking a button with Alt held moves focus there, so the mouse stay free for the UI
      const active = document.activeElement;
      if (active === null || active === document.body || active.contains(this.domElement)) {
        this.capture();
      }
      return;
    }
    if (HANDLED_KEYS.has(event.code)) this.keys.delete(event.code);
  };

  private readonly clearInput = () => {
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.dragging = false;
    this.altFreed = false;
    this.physicsPosition.copy(this.camera.position);
    this.previousPhysics.copy(this.camera.position);
    this.accumulated = 0;
  };

  private readonly onVisibilityChange = () => {
    if (document.hidden) this.clearInput();
  };

  private applyRotation(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }
}
