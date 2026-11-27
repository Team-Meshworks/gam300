import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FpsMobileControls } from "./FpsControls";
import { MobileControls } from "./MobileControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const controls = { setMove: vi.fn(), setLook: vi.fn(), jump: vi.fn() };

beforeEach(() => {
  // jsdom has no layout or pointer capture; each stick is a 100 px square at the origin
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => true;
  HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(MobileControls, { controls: controls as unknown as FpsMobileControls }),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
}
// The DOM shortens translate(x, 0px) to translate(x), so compare the numbers
function offset(thumb: HTMLElement) {
  const [x = 0, y = 0] = (thumb.style.transform.match(/-?[\d.]+/g) ?? []).map(Number);
  return [x, y];
}
function stick(name: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  return { button, thumb: button.querySelector<HTMLElement>(".mobile-joystick-thumb")! };
}

it.each(["Move", "Look"])(
  "moves the %s thumb with the finger and recentres it on release",
  (name) => {
    const { button, thumb } = stick(name);
    pointer(button, "pointerdown", 50, 50);
    pointer(button, "pointermove", 70, 40);
    expect(offset(thumb)).toEqual([20, -10]);
    // Dragging past the base keeps the thumb on its rim
    pointer(button, "pointermove", 150, 50);
    expect(offset(thumb)).toEqual([42, 0]);
    pointer(button, "pointerup", 150, 50);
    expect(offset(thumb)).toEqual([0, 0]);
  },
);

it("keeps looking by drag distance while the thumb follows", () => {
  const { button } = stick("Look");
  pointer(button, "pointerdown", 50, 50);
  pointer(button, "pointermove", 60, 50);
  pointer(button, "pointermove", 60, 50);
  expect(controls.setLook).toHaveBeenNthCalledWith(1, 15, 0);
  // Holding the thumb still stops turning even though it is off-centre
  expect(controls.setLook).toHaveBeenNthCalledWith(2, 0, 0);
  expect(controls.setMove).not.toHaveBeenCalled();
});
