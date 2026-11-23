import { Box3, Vector3 } from "three";

// Index world bounds with the visitor radius included, so each query reads one cell.
export function walkGrid<T>(bounds: Box3, radius: number) {
  const size = bounds.getSize(new Vector3());
  const columns = Math.max(1, Math.min(16, Math.ceil(size.x / 2)));
  const rows = Math.max(1, Math.min(16, Math.ceil(size.z / 2)));
  const cells = Array.from({ length: columns * rows }, (): T[] => []);
  const column = (x: number) =>
    Math.min(columns - 1, Math.max(0, Math.floor(((x - bounds.min.x) / (size.x || 1)) * columns)));
  const row = (z: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor(((z - bounds.min.z) / (size.z || 1)) * rows)));
  return {
    at(x: number, z: number) {
      if (
        x < bounds.min.x - radius ||
        x > bounds.max.x + radius ||
        z < bounds.min.z - radius ||
        z > bounds.max.z + radius
      )
        return undefined;
      return cells[row(z) * columns + column(x)]!;
    },
    add(box: Box3, item: T) {
      const endX = column(box.max.x + radius);
      const endZ = row(box.max.z + radius);
      for (let z = row(box.min.z - radius); z <= endZ; z++) {
        for (let x = column(box.min.x - radius); x <= endX; x++) cells[z * columns + x]!.push(item);
      }
    },
  };
}
