import { afterEach, describe, expect, it } from "vitest";
import { loadDockEdge, nearestEdge, saveDockEdge } from "./dock-edge";

afterEach(() => {
  localStorage.removeItem("spatia-dock-edge");
});

describe("nearest dock edge", () => {
  it("picks the edge closest to the pointer", () => {
    expect(nearestEdge(500, 750, 1000, 800)).toBe("bottom");
    expect(nearestEdge(500, 40, 1000, 800)).toBe("top");
    expect(nearestEdge(30, 400, 1000, 800)).toBe("left");
    expect(nearestEdge(980, 400, 1000, 800)).toBe("right");
  });

  it("compares real distances on a wide screen", () => {
    // 150px from the left is closer than 300px from the bottom
    expect(nearestEdge(150, 500, 1600, 800)).toBe("left");
  });
});

describe("remembered dock edge", () => {
  it("saves and loads the edge", () => {
    saveDockEdge("right");
    expect(loadDockEdge()).toBe("right");
  });

  it("falls back to the bottom for unknown values", () => {
    localStorage.setItem("spatia-dock-edge", "diagonal");
    expect(loadDockEdge()).toBe("bottom");
  });
});
