import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { FpsMobileControls } from "../graphics/scene";

type JoystickProps = {
  label: string;
  side: "left" | "right";
  onMove: (x: number, y: number) => void;
  onRelease: () => void;
};

const STICK_RADIUS = 42;
const LOOK_SENSITIVITY = 1.5;

function Joystick({ label, side, onMove, onRelease }: JoystickProps) {
  const pointerId = useRef<number | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
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
    if (side === "right") {
      onMove(
        (event.clientX - lastPoint.current.x) * LOOK_SENSITIVITY,
        (event.clientY - lastPoint.current.y) * LOOK_SENSITIVITY,
      );
      lastPoint.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(x, y);
    const scale = distance > STICK_RADIUS ? STICK_RADIUS / distance : 1;
    const clamped = { x: x * scale, y: y * scale };
    setOffset(clamped);
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
      <span className="mobile-joystick-base" aria-hidden="true">
        <span
          className="mobile-joystick-thumb"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        />
      </span>
    </button>
  );
}

export function MobileControls({ controls }: { controls: FpsMobileControls }) {
  const [flyEnabled, setFlyEnabled] = useState(false);

  return (
    <div className="mobile-controls" aria-label="Mobile first-person controls">
      <Joystick
        label="Move"
        side="left"
        onMove={(x, y) => controls.setMove(x, y)}
        onRelease={() => controls.setMove(0, 0)}
      />
      <button
        className="mobile-fly-toggle"
        type="button"
        aria-pressed={flyEnabled}
        onClick={() => {
          const next = !flyEnabled;
          setFlyEnabled(next);
          controls.setFlyEnabled(next);
        }}
      >
        Fly
      </button>
      <Joystick
        label="Look"
        side="right"
        onMove={(x, y) => controls.setLook(x, y)}
        onRelease={() => undefined}
      />
    </div>
  );
}
