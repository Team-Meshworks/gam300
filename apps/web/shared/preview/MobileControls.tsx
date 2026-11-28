import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { FpsMobileControls } from "./FpsControls";

type JoystickProps = {
  label: string;
  side: "left" | "right";
  onMove: (x: number, y: number) => void;
  onRelease: () => void;
};

const STICK_RADIUS = 42;
const LOOK_SENSITIVITY = 1.5;

// How far the thumb's centre can move before its edge leaves the base
function thumbReach(base: HTMLElement | null, thumb: HTMLElement | null) {
  const reach =
    base && thumb
      ? (base.getBoundingClientRect().width - thumb.getBoundingClientRect().width) / 2
      : 0;
  return reach > 0 ? reach : STICK_RADIUS;
}

function Joystick({ label, side, onMove, onRelease }: JoystickProps) {
  const pointerId = useRef<number | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const base = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  function stop(event: ReactPointerEvent<HTMLButtonElement>) {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setOffset({ x: 0, y: 0 });
    onRelease();
  }

  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    if (pointerId.current !== event.pointerId) return;
    // Both thumbs follow the finger, clamped to the base, so each stick shows it is held
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(x, y);
    const scale = distance > STICK_RADIUS ? STICK_RADIUS / distance : 1;
    const clamped = { x: x * scale, y: y * scale };
    // The sticks shrink on portrait phones, so the thumb's reach comes from their rendered sizes
    const rim = thumbReach(base.current, thumb.current);
    const shown = distance > rim ? rim / distance : 1;
    setOffset({ x: x * shown, y: y * shown });
    if (side === "right") {
      // Looking turns by drag distance like a swipe, not by how far the thumb is held out
      onMove(
        (event.clientX - lastPoint.current.x) * LOOK_SENSITIVITY,
        (event.clientY - lastPoint.current.y) * LOOK_SENSITIVITY,
      );
      lastPoint.current = { x: event.clientX, y: event.clientY };
      return;
    }
    onMove(clamped.x / STICK_RADIUS, -clamped.y / STICK_RADIUS);
  }

  return (
    <button
      className={`mobile-joystick mobile-joystick--${side}`}
      type="button"
      aria-label={label}
      onPointerDown={(event) => {
        if (pointerId.current !== null) return;
        pointerId.current = event.pointerId;
        lastPoint.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      <span ref={base} className="mobile-joystick-base" aria-hidden="true">
        <span
          ref={thumb}
          className="mobile-joystick-thumb"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        />
      </span>
    </button>
  );
}

export function MobileControls({
  controls,
  allowFlight = true,
}: {
  controls: FpsMobileControls;
  allowFlight?: boolean;
}) {
  return (
    <div className="mobile-controls" aria-label="Mobile first-person controls">
      <div className="mobile-controls-left">
        <Joystick
          label="Move"
          side="left"
          onMove={(x, y) => controls.setMove(x, y)}
          onRelease={() => controls.setMove(0, 0)}
        />
        <button
          className="mobile-jump-button"
          type="button"
          aria-label={allowFlight ? "Jump. Press twice quickly to toggle flying." : "Jump"}
          onClick={() => {
            controls.jump();
          }}
        >
          Jump
        </button>
      </div>
      <Joystick
        label="Look"
        side="right"
        onMove={(x, y) => controls.setLook(x, y)}
        onRelease={() => undefined}
      />
    </div>
  );
}
