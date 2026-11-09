import type { Vector3Tuple } from "../../shared/project/project-types";

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 100;
const SCALE_PER_PIXEL = 0.001;
const LINE_PIXELS = 16;
const PAGE_PIXELS = 400;

export function wheelScaleFactor(deltaY: number, deltaMode: number) {
  const pixels = deltaY * (deltaMode === 1 ? LINE_PIXELS : deltaMode === 2 ? PAGE_PIXELS : 1);
  return Math.exp(-pixels * SCALE_PER_PIXEL);
}

export function scaleBy(scale: Vector3Tuple, factor: number, axis?: 0 | 1 | 2): Vector3Tuple {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return scale;
  if (axis !== undefined) {
    const next: [number, number, number] = [...scale];
    next[axis] = limit(scale[axis], scale[axis] * factor);
    return next;
  }
  let shared = factor;
  for (const value of scale) {
    shared = limit(value, value * shared) / value;
  }
  return [scale[0] * shared, scale[1] * shared, scale[2] * shared];
}

function limit(before: number, after: number) {
  return after < before
    ? Math.max(after, Math.min(before, MIN_SCALE))
    : Math.min(after, Math.max(before, MAX_SCALE));
}
