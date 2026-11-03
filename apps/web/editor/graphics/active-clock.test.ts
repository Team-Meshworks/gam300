import { expect, it, vi } from "vitest";
import { createActiveClock } from "./active-clock";
import { createInteractionHandler } from "../interaction/interactionHandler";

it("fires a two-second interaction after eight 250-ms frames", () => {
  const run = vi.fn();
  const handler = createInteractionHandler(
    [{ when: { type: "time-elapsed", seconds: 2 }, do: { type: "print-hi" } }],
    [],
    { run, stop: vi.fn() },
  );
  const clock = createActiveClock(0, true);
  for (let now = 250; now < 2000; now += 250) handler.update(clock.tick(now));
  expect(run).not.toHaveBeenCalled();
  handler.update(clock.tick(2000));
  expect(run).toHaveBeenCalledTimes(1);
  handler.update(clock.tick(2250));
  expect(run).toHaveBeenCalledTimes(1);
});

it("excludes hidden time without losing active time before hiding or after resuming", () => {
  const clock = createActiveClock(0, true);
  expect(clock.tick(250)).toBe(0.25);
  clock.setActive(400, false);
  clock.setActive(10400, true);
  expect(clock.tick(10650)).toBeCloseTo(0.4);
  clock.setActive(10700, false);
  expect(clock.tick(20700)).toBeCloseTo(0.05);
  expect(clock.tick(30700)).toBe(0);
  clock.reset(40000, true);
  expect(clock.tick(40250)).toBe(0.25);
});
