import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDockEdge, nearestEdge, saveDockEdge } from "./dock-edge";

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

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
    vi.stubGlobal("localStorage", memoryStorage());
    saveDockEdge("right");
    expect(loadDockEdge()).toBe("right");
  });

  it("falls back to the bottom for unknown values", () => {
    const storage = memoryStorage();
    storage.setItem("spatia-dock-edge", "diagonal");
    vi.stubGlobal("localStorage", storage);
    expect(loadDockEdge()).toBe("bottom");
  });

  it("falls back to the bottom when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
    expect(() => saveDockEdge("left")).not.toThrow();
    expect(loadDockEdge()).toBe("bottom");
  });
});
