// Track active wall time independently from the movement integrator's capped step.
export function createActiveClock(now: number, active: boolean) {
  let last = now;
  let pending = 0;
  function advance(now: number) {
    if (active) pending += Math.max(0, now - last) / 1000;
    last = now;
  }
  return {
    setActive(now: number, next: boolean) {
      advance(now);
      active = next;
    },
    reset(now: number, next: boolean) {
      last = now;
      pending = 0;
      active = next;
    },
    tick(now: number) {
      advance(now);
      const elapsed = pending;
      pending = 0;
      return elapsed;
    },
  };
}
