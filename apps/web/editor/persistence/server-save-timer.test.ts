import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServerSaveTimer } from "./server-save-timer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("waits for quiet edits but reaches the deadline during continuous editing", () => {
  const ready = vi.fn();
  const timer = createServerSaveTimer(ready);
  timer.schedule();
  vi.advanceTimersByTime(1_000);
  timer.schedule();
  vi.advanceTimersByTime(1_999);
  expect(ready).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(ready).toHaveBeenCalledTimes(1);

  // Each new batch gets its own five-second limit
  for (let edit = 0; edit < 5; edit += 1) {
    timer.schedule();
    vi.advanceTimersByTime(1_000);
  }
  expect(ready).toHaveBeenCalledTimes(2);
});

it("cancels the pending callback and resets the deadline for the next batch", () => {
  const ready = vi.fn();
  const timer = createServerSaveTimer(ready);
  timer.schedule();
  vi.advanceTimersByTime(1_000);
  timer.cancel();
  vi.advanceTimersByTime(10_000);
  expect(ready).not.toHaveBeenCalled();
  timer.schedule();
  vi.advanceTimersByTime(1_999);
  expect(ready).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(ready).toHaveBeenCalledTimes(1);
});
