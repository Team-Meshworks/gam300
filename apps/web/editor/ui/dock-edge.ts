export type DockEdge = "bottom" | "top" | "left" | "right";

export const dockEdges: readonly DockEdge[] = ["bottom", "top", "left", "right"];

const storageKey = "spatia-dock-edge";

// Bar snap to whichever edge the pointer is closest to when let go
export function nearestEdge(x: number, y: number, width: number, height: number): DockEdge {
  const distances: [DockEdge, number][] = [
    ["bottom", height - y],
    ["top", y],
    ["left", x],
    ["right", width - x],
  ];
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
}

// Storage can be blocked or full, then just start at the bottom and dont remember
export function loadDockEdge(): DockEdge {
  try {
    const saved = localStorage.getItem(storageKey);
    return dockEdges.find((edge) => edge === saved) ?? "bottom";
  } catch {
    return "bottom";
  }
}

export function saveDockEdge(edge: DockEdge) {
  try {
    localStorage.setItem(storageKey, edge);
  } catch {
    // Nothing to do, the bar still move for this visit
  }
}
