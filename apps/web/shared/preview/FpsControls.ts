import * as THREE from "three";
import { EYE_HEIGHT, type createWalkSpace } from "./walk-space";
export { EYE_HEIGHT } from "./walk-space";
function isTextEditingTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [role="textbox"]') !== null)
  );
}

// Slower than before, 5 and 12 m/s made people feel sick
const WALK_SPEED = 3;
const SPRINT_SPEED = 7;
const ACCELERATION = 60;
const GRAVITY = 20;
const JUMP_SPEED = 6;
// Two Space presses this close together turn flying on or off, like Minecraft creative
const DOUBLE_TAP_MS = 300;
const LOOK_SPEED = 0.002;
const MAX_LOOK_STEP = 100;
const MAX_PITCH = Math.PI / 2 - 0.01;
const PHYSICS_DT = 1 / 240;
const LOCK_RETRY_MS = 2000;

// C goes down instead of Ctrl, Ctrl+W closes the tab and Ctrl is kept for snapping
const WALK_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);
const HANDLED_KEYS = new Set([...WALK_KEYS, "KeyC", "Space", "ShiftLeft", "ShiftRight"]);

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();

export interface FpsMobileControls {
  setMove(x: number, z: number): void;
  setLook(x: number, y: number): void;
  jump(): void;
}

export class FpsControls {
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window | null;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private minimumHeight = EYE_HEIGHT;
  private standingHeight = EYE_HEIGHT;
  private walkSpace?: ReturnType<typeof createWalkSpace> | undefined;
  private walkingUnavailable = false;
  private dragging = false;
  private engaged = false;
  private flying = false;
  private lastSpace = -Infinity;
  private captured = false;
  private capturePending = false;
  private releasedAt = -Infinity;
  private ignoreNextCapturedMove = false;
  // Embedded browsers can refuse the lock for good, then dragging is how you look around
  private lockable: boolean;
  // Alt let go of the mouse, so letting go of Alt should take it back
  private altFreed = false;
  // Turning a held object uses the mouse, so the camera doesnt look around meanwhile
  private lookHeld = false;
  // Preview walks like a visitor, nothing starts flying there
  private flightAllowed = true;
  // Keep the authored pose until movement places a grounded camera in the walkable space
  private perched = false;
  private readonly _euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly physicsPosition = new THREE.Vector3();
  private readonly previousPhysics = new THREE.Vector3();
  private accumulated = 0;
  private mobileMoveX = 0;
  private mobileMoveZ = 0;
  private mobileLookX = 0;
  private mobileLookY = 0;
  private mobileJump = false;
  private lastMobileJump = -Infinity;
  readonly mobileControls: FpsMobileControls = {
    setMove: (x, z) => {
      this.mobileMoveX = THREE.MathUtils.clamp(x, -1, 1);
      this.mobileMoveZ = THREE.MathUtils.clamp(z, -1, 1);
      if (this.engaged && (x || z)) this.onNavigationInput?.();
    },
    setLook: (x, y) => {
      if (this.engaged && (x || y)) this.onNavigationInput?.();
      this.mobileLookX += x;
      this.mobileLookY += y;
    },
    jump: () => {
      if (this.engaged) this.onNavigationInput?.();
      const now = performance.now();
      if (this.flightAllowed && now - this.lastMobileJump < DOUBLE_TAP_MS) {
        this.toggleFlight();
        this.lastMobileJump = -Infinity;
      } else {
        this.lastMobileJump = now;
        this.mobileJump = true;
      }
    },
  };
  onNavigationInput?: () => void;
  onCaptureChange: () => void = () => {};

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.ownerDocument = domElement.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView;
    this.lockable = typeof domElement.requestPointerLock === "function";
    domElement.addEventListener("mousedown", this.onPointerDown);
    this.ownerDocument.addEventListener("mousemove", this.onPointerMove);
    this.ownerDocument.addEventListener("mouseup", this.onPointerUp);
    this.ownerDocument.addEventListener("pointerlockchange", this.onLockChange);
    this.ownerDocument.addEventListener("pointerlockerror", this.onLockError);
  }

  engage(): void {
    if (this.engaged) return;
    this.engaged = true;
    this.keys.clear();
    this.dragging = false;
    this.resetMobileInput();
    this.sync();
    this.ownerWindow?.addEventListener("keydown", this.onKeyDown);
    this.ownerWindow?.addEventListener("keyup", this.onKeyUp, true);
    this.ownerWindow?.addEventListener("blur", this.clearInput);
    this.ownerDocument.addEventListener("focusin", this.onFocusIn, true);
    this.ownerDocument.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private syncWalkFloor(position: THREE.Vector3): void {
    const floor = this.walkSpace?.place(position.clone());
    this.walkingUnavailable = this.walkSpace !== undefined && floor === undefined;
    this.standingHeight = EYE_HEIGHT + (floor ?? 0);
    // Preserve authored viewpoints below normal standing height.
    this.minimumHeight = Math.min(this.standingHeight, position.y);
  }

  // Pick up from wherever the camera is now. Starting in the air means flying, so nothing drops.
  // Preview cant fly, so a raised camera is held there instead
  sync(): void {
    this.syncWalkFloor(this.camera.position);
    this.stopMotion();
    const raised = this.camera.position.y > this.standingHeight + 1e-4;
    this.flying = raised && this.flightAllowed;
    this.perched = !this.flightAllowed || this.walkSpace !== undefined;
    this._euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this._euler.y;
    this.pitch = this._euler.x;
    this.roll = this._euler.z;
    this.applyRotation();
  }

  lookAt(target: THREE.Vector3): void {
    if (this.camera.position.distanceToSquared(target) < 1e-8) return;
    this.camera.lookAt(target);
    this._euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this._euler.y;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this._euler.x));
    // Turning to face something is always upright
    this.roll = 0;
    this.applyRotation();
  }

  // Pose restoration resets physics; selecting or manipulating an object must not
  private stopMotion(): void {
    this.velocity.set(0, 0, 0);
    this.physicsPosition.copy(this.camera.position);
    this.previousPhysics.copy(this.camera.position);
    this.accumulated = 0;
  }

  private get inputX(): number {
    return (
      Number(this.keys.has("KeyD") || this.keys.has("ArrowRight")) -
      Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft")) +
      this.mobileMoveX
    );
  }

  private get inputZ(): number {
    return (
      Number(this.keys.has("KeyW") || this.keys.has("ArrowUp")) -
      Number(this.keys.has("KeyS") || this.keys.has("ArrowDown")) +
      this.mobileMoveZ
    );
  }

  // Ballistic jump/fall and decaying velocity are not deliberate carry input
  hasMovementInput(): boolean {
    return (
      this.inputX !== 0 ||
      this.inputZ !== 0 ||
      (this.flying && (this.keys.has("Space") || this.keys.has("KeyC")))
    );
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

  isEngaged(): boolean {
    return this.engaged;
  }

  canCapture(): boolean {
    return this.lockable;
  }

  holdLook(held: boolean): void {
    this.lookHeld = held;
  }

  setFlightAllowed(allowed: boolean): void {
    this.flightAllowed = allowed;
    if (!allowed) {
      this.flying = false;
      this.perched = true;
    }
  }

  setWalkSpace(space: ReturnType<typeof createWalkSpace> | undefined): void {
    const previous = this.walkSpace;
    this.walkSpace = space;
    if (!this.engaged) return;
    if (!previous && space && this.velocity.y === 0) this.sync();
    else this.refreshWalkPlacement();
  }

  refreshWalkObstacles(): void {
    if (
      this.engaged &&
      (this.walkingUnavailable || this.walkSpace?.insideProp(this.physicsPosition))
    )
      this.refreshWalkPlacement();
  }

  private refreshWalkPlacement(): void {
    if (!this.flightAllowed) {
      this.sync();
      return;
    }
    // An edit can change support under the camera. Keep jump velocity and flight state.
    this.syncWalkFloor(this.physicsPosition);
    if (this.physicsPosition.y <= this.standingHeight + 1e-4) this.flying = false;
    this.perched = this.walkSpace !== undefined;
  }

  private toggleFlight(): void {
    this.flying = !this.flying;
    this.velocity.y = 0;
    this.perched = this.walkSpace !== undefined;
  }

  // A viewpoint or saved camera just moved the camera, carry on from exactly that pose
  syncFromCamera(): void {
    this.clearInput();
    this.sync();
  }

  disengage(): void {
    if (!this.engaged) return;
    this.engaged = false;
    this.capturePending = false;
    this.dragging = false;
    this.altFreed = false;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.resetMobileInput();
    if (this.captured) this.ownerDocument.exitPointerLock();
    this.ownerWindow?.removeEventListener("keydown", this.onKeyDown);
    this.ownerWindow?.removeEventListener("keyup", this.onKeyUp, true);
    this.ownerWindow?.removeEventListener("blur", this.clearInput);
    this.ownerDocument.removeEventListener("focusin", this.onFocusIn, true);
    this.ownerDocument.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  dispose(): void {
    this.disengage();
    this.domElement.removeEventListener("mousedown", this.onPointerDown);
    this.ownerDocument.removeEventListener("mousemove", this.onPointerMove);
    this.ownerDocument.removeEventListener("mouseup", this.onPointerUp);
    this.ownerDocument.removeEventListener("pointerlockchange", this.onLockChange);
    this.ownerDocument.removeEventListener("pointerlockerror", this.onLockError);
  }

  update(delta: number): void {
    if (!this.engaged) return;

    this.applyRotation();

    this.accumulated += Math.min(delta, 0.25);
    while (this.accumulated >= PHYSICS_DT) {
      this.previousPhysics.copy(this.physicsPosition);
      this.step(PHYSICS_DT);
      // Consume a queued tap only after a physics step
      this.mobileJump = false;
      this.accumulated -= PHYSICS_DT;
    }

    this.camera.position
      .copy(this.previousPhysics)
      .lerp(this.physicsPosition, this.accumulated / PHYSICS_DT);
  }

  private step(delta: number): void {
    // Keep look and viewpoint navigation available without walking through unsupported rooms
    if (this.walkingUnavailable && !this.flying) return;
    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const space = this.keys.has("Space") || this.mobileJump;
    const maxSpeed = sprint ? SPRINT_SPEED : WALK_SPEED;
    if (!this.flightAllowed) this.flying = false;
    if (this.perched && !this.flying) {
      // Looking alone keeps an authored pose. An editor already in motion keeps moving.
      if (
        !space &&
        !this.hasMovementInput() &&
        (!this.flightAllowed || (this.onFloor() && this.velocity.lengthSq() < 1e-8))
      ) {
        this.velocity.set(0, 0, 0);
        return;
      }
      this.perched = false;
      // Enter the walkable space only on movement, before integrating collision steps
      if (this.walkSpace) {
        const floor = this.walkSpace.place(this.physicsPosition);
        if (floor === undefined) {
          this.walkingUnavailable = true;
          return;
        }
        this.standingHeight = floor + EYE_HEIGHT;
        this.minimumHeight = Math.min(this.standingHeight, this.physicsPosition.y);
        this.previousPhysics.copy(this.physicsPosition);
      }
    }

    _forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    if (!this.flying) _forward.y = 0;
    if (_forward.lengthSq() < 1e-8) {
      _forward.set(0, 0, -1);
    } else {
      _forward.normalize();
    }

    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _right.y = 0;
    _right.normalize();

    _wish.set(0, 0, 0).addScaledVector(_forward, this.inputZ).addScaledVector(_right, this.inputX);
    if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(maxSpeed);

    const smoothing = 1 - Math.exp(-ACCELERATION * delta);
    const previous = this.velocity.clone();
    if (this.flying) {
      // In flight, the mobile forward stick follows the camera pitch. Keyboard
      // vertical input remains available without overriding that direction.
      _wish.y += ((space ? 1 : 0) - (this.keys.has("KeyC") ? 1 : 0)) * WALK_SPEED;
      this.velocity.lerp(_wish, smoothing);
    } else {
      // Only the sideways part eases in, up and down is jumping and gravity
      let fall = this.velocity.y - GRAVITY * delta;
      if (space && this.onFloor()) fall = JUMP_SPEED;
      this.velocity.lerp(_wish, smoothing);
      this.velocity.y = fall;
    }
    this.physicsPosition.addScaledVector(previous.lerp(this.velocity, 0.5), delta);
    if (this.walkSpace && !this.flying) {
      const targetY = this.physicsPosition.y;
      const eyeClearance = EYE_HEIGHT + this.minimumHeight - this.standingHeight;
      this.standingHeight =
        this.walkSpace.move(this.previousPhysics, this.physicsPosition, eyeClearance) + EYE_HEIGHT;
      this.minimumHeight = this.standingHeight - EYE_HEIGHT + eyeClearance;
      if (this.physicsPosition.y < targetY) this.velocity.y = Math.min(0, this.velocity.y);
    }
    // An authored low viewpoint is the floor until you climb back to eye height
    if (this.physicsPosition.y >= this.standingHeight) this.minimumHeight = this.standingHeight;
    if (this.physicsPosition.y <= this.minimumHeight) {
      this.physicsPosition.y = this.minimumHeight;
      this.velocity.y = Math.max(this.velocity.y, 0);
      // Re-enter the walkable area on the next move after landing a free flight.
      if (this.flying && this.walkSpace) this.perched = true;
      this.flying = false;
    }
  }

  private onFloor(): boolean {
    return this.physicsPosition.y <= this.minimumHeight + 1e-4;
  }

  private capture(): void {
    if (!this.engaged || !this.lockable || this.capturePending) return;
    this.capturePending = true;
    // Some browsers return nothing, others a promise that rejects when the lock is refused
    try {
      Promise.resolve(this.domElement.requestPointerLock()).catch(this.onCaptureFailure);
    } catch (error) {
      this.onCaptureFailure(error);
    }
  }

  private readonly onCaptureFailure = (error?: unknown) => {
    if (!this.capturePending) return;
    this.capturePending = false;
    if (!this.engaged) return;
    // Escape temporarily refuses recapture; an initial sandbox denial must enable drag fallback
    if (
      performance.now() - this.releasedAt < LOCK_RETRY_MS &&
      (error === undefined || (error instanceof DOMException && error.name === "SecurityError"))
    )
      return;
    this.lockable = false;
    this.onCaptureChange();
  };

  private readonly onLockError = () => this.onCaptureFailure();

  private readonly onPointerDown = (event: MouseEvent) => {
    if (!this.engaged || event.button !== 0) return;
    if (this.wantsCapture(event)) this.capture();
    // Without the lock (touch, Alt held, or refused), dragging still turns the camera
    if (!this.captured) this.dragging = true;
  };

  private readonly onPointerMove = (event: MouseEvent) => {
    if (!this.engaged || this.lookHeld || (!this.captured && !this.dragging)) return;
    if (this.captured && this.ignoreNextCapturedMove) {
      this.ignoreNextCapturedMove = false;
      return;
    }
    // Browsers can report stale, very large, or non-finite deltas when pointer
    // lock is acquired or restored. Ignore those events instead of teleporting.
    if (
      !Number.isFinite(event.movementX) ||
      !Number.isFinite(event.movementY) ||
      Math.abs(event.movementX) > MAX_LOOK_STEP ||
      Math.abs(event.movementY) > MAX_LOOK_STEP
    )
      return;
    const movementX = event.movementX;
    const movementY = event.movementY;
    if (movementX || movementY) this.onNavigationInput?.();
    this.yaw -= movementX * LOOK_SPEED;
    this.pitch -= movementY * LOOK_SPEED;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };

  private readonly onLockChange = () => {
    const captured = this.ownerDocument.pointerLockElement === this.domElement;
    if (captured === this.captured) return;
    this.captured = captured;
    if (captured) this.capturePending = false;
    else {
      this.releasedAt = performance.now();
      this.releaseKeyboard();
    }
    this.dragging = false;
    this.ignoreNextCapturedMove = captured;
    this.onCaptureChange();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      // Stops Windows from jumping to the browser menu when Alt is let go
      event.preventDefault();
      // Ask the browser, the lock change event can arrive after a quick Alt press
      if (this.ownerDocument.pointerLockElement === this.domElement && !event.repeat) {
        this.altFreed = true;
        this.ownerDocument.exitPointerLock();
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
      (event.target instanceof Element &&
        event.target.closest(
          "button, summary, details[open], dialog[open], a[href], audio[controls], video[controls]",
        ))
    )
      return;
    if (!HANDLED_KEYS.has(event.code)) return;
    event.preventDefault();
    // A held key may auto-repeat after the player has surrendered keyboard focus.
    if (event.repeat && !this.keys.has(event.code)) return;
    if (event.code === "Space" && !event.repeat) {
      if (this.flightAllowed && event.timeStamp - this.lastSpace < DOUBLE_TAP_MS) {
        this.toggleFlight();
        this.lastSpace = -Infinity;
      } else {
        this.lastSpace = event.timeStamp;
      }
    }
    this.keys.add(event.code);
    if (event.code === "Space" || this.hasMovementInput()) this.onNavigationInput?.();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      event.preventDefault();
      if (!this.altFreed) return;
      this.altFreed = false;
      // Clicking a button with Alt held moves focus there, so the mouse stay free for the UI
      const active = this.ownerDocument.activeElement;
      if (
        active === null ||
        active === this.ownerDocument.body ||
        active.contains(this.domElement)
      ) {
        this.capture();
      }
      return;
    }
    if (this.keys.delete(event.code) && WALK_KEYS.has(event.code)) this.stopKeyboardWalk();
  };

  private stopKeyboardWalk(): void {
    if (this.flying || this.inputX !== 0 || this.inputZ !== 0) return;
    // Stop at the displayed position, leaving vertical jump/fall physics alone.
    for (const axis of ["x", "z"] as const) {
      this.velocity[axis] = 0;
      this.physicsPosition[axis] = this.camera.position[axis];
      this.previousPhysics[axis] = this.camera.position[axis];
    }
  }

  private releaseKeyboard(): void {
    if (this.keys.size === 0) return;
    this.keys.clear();
    this.stopKeyboardWalk();
  }

  private readonly onFocusIn = (event: FocusEvent) => {
    if (event.target !== this.domElement) this.releaseKeyboard();
  };

  private readonly clearInput = () => {
    this.keys.clear();
    this.stopMotion();
    this.dragging = false;
    this.resetMobileInput();
    this.altFreed = false;
  };

  private readonly onVisibilityChange = () => {
    if (this.ownerDocument.hidden) this.clearInput();
  };

  private applyRotation(): void {
    this.yaw -= this.mobileLookX * LOOK_SPEED;
    // Clamp deliberate look input, never an untouched authored vertical pose
    if (this.mobileLookY !== 0) {
      this.pitch -= this.mobileLookY * LOOK_SPEED;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    }
    this.mobileLookX = 0;
    this.mobileLookY = 0;
    this.camera.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
  }

  private resetMobileInput(): void {
    this.mobileMoveX = 0;
    this.mobileMoveZ = 0;
    this.mobileLookX = 0;
    this.mobileLookY = 0;
    this.mobileJump = false;
    this.lastMobileJump = -Infinity;
  }
}
