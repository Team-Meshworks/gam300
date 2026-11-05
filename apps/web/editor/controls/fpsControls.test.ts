import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { FpsControls } from "./fpsControls";

afterEach(() => vi.unstubAllGlobals());

it("drops residual motion without dropping deliberately held movement", () => {
  const events = new EventTarget();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  const camera = new THREE.PerspectiveCamera();
  camera.position.y = 0.9;
  const controls = new FpsControls(camera, new EventTarget() as HTMLElement);
  controls.engage();
  controls.mobileControls.setMove(1, 0);
  for (let i = 0; i < 36; i++) controls.update(1 / 60);
  expect(camera.position.x).toBeGreaterThan(1);
  controls.mobileControls.setMove(0, 0);
  controls.stopMotion();
  const stopped = camera.position.clone();
  for (let i = 0; i < 6; i++) controls.update(1 / 60);
  expect(camera.position.distanceTo(stopped)).toBeLessThan(1e-9);
  controls.mobileControls.setMove(1, 0);
  controls.stopMotion();
  for (let i = 0; i < 6; i++) controls.update(1 / 60);
  expect(camera.position.distanceTo(stopped)).toBeGreaterThan(0.1);
  controls.dispose();
});

it("keeps pointer-lock retry available immediately after releasing a successful lock", async () => {
  const documentEvents = Object.assign(new EventTarget(), {
    pointerLockElement: null as EventTarget | null,
  });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("PointerEvent", class extends Event {});
  const events = new EventTarget();
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  const request = vi.fn(() => Promise.reject(new DOMException("Recent escape", "SecurityError")));
  const element = Object.assign(new EventTarget(), { requestPointerLock: request });
  const controls = new FpsControls(
    new THREE.PerspectiveCamera(),
    element as unknown as HTMLElement,
  );
  controls.engage();
  documentEvents.pointerLockElement = element;
  documentEvents.dispatchEvent(new Event("pointerlockchange"));
  documentEvents.pointerLockElement = null;
  documentEvents.dispatchEvent(new Event("pointerlockchange"));
  const click = Object.assign(new Event("mousedown"), { button: 0, altKey: false });
  element.dispatchEvent(click);
  await Promise.resolve();
  expect(controls.canCapture()).toBe(true);
  element.dispatchEvent(click);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  controls.dispose();
});

it.each([
  [0.2, 0.3],
  [4, 0.3],
  [0.2, Math.PI / 2],
  [4, -Math.PI / 2],
])(
  "keeps a teleported visitor at height %s and pitch %s across physics frames",
  (height, pitch) => {
    const events = new EventTarget();
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const controls = new FpsControls(camera, new EventTarget() as HTMLElement);
    controls.engage();
    controls.update(0.1);
    camera.position.set(20, height, -12);
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, 1.2, 0.2, "YXZ"));
    const pose = camera.clone();
    controls.syncFromCamera();
    for (let i = 0; i < 60; i++) controls.update(1 / 60);
    expect(camera.position.distanceTo(pose.position)).toBeLessThan(1e-9);
    expect(camera.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
    controls.dispose();
  },
);

it.each(["reject", "throw", "event"])(
  "falls back after sandbox pointer-lock denial via %s",
  async (delivery) => {
    const documentEvents = new EventTarget();
    Object.assign(documentEvents, {
      defaultView: {
        frameElement: {
          getAttribute: () => "allow-scripts allow-same-origin",
          ownerDocument: { defaultView: null },
        },
      },
    });
    vi.stubGlobal("document", documentEvents);
    vi.stubGlobal("PointerEvent", class extends Event {});
    const windowEvents = new EventTarget();
    vi.stubGlobal("addEventListener", windowEvents.addEventListener.bind(windowEvents));
    vi.stubGlobal("removeEventListener", windowEvents.removeEventListener.bind(windowEvents));
    const element = Object.assign(new EventTarget(), {
      ownerDocument: documentEvents,
      requestPointerLock: () => {
        const error = new DOMException("Pointer lock blocked by sandbox", "SecurityError");
        if (delivery === "throw") throw error;
        if (delivery === "event") {
          documentEvents.dispatchEvent(new Event("pointerlockerror"));
          return;
        }
        return Promise.reject(error);
      },
    });
    const controls = new FpsControls(
      new THREE.PerspectiveCamera(),
      element as unknown as HTMLElement,
    );
    controls.engage();
    const click = Object.assign(new Event("mousedown"), { button: 0, altKey: false });
    element.dispatchEvent(click);
    await Promise.resolve();
    expect(controls.canCapture()).toBe(false);
    expect(controls.wantsCapture(click as unknown as MouseEvent)).toBe(false);
    controls.dispose();
  },
);
