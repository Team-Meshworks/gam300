import { Box3, Mesh, Object3D, Ray, Triangle, Vector3 } from "three";

// Flat-floor walkthrough dimensions in world metres, independent of model scale
export const EYE_HEIGHT = 0.9;
const HALF_WIDTH = 0.22;
const HEIGHT = 1.55;
const MAX_STEP = 0.24;
const EPSILON = 0.0001;
const footprint = Array.from({ length: 8 }, (_, index) => {
  const angle = (index * Math.PI) / 4;
  return { x: HALF_WIDTH * Math.cos(angle), z: HALF_WIDTH * Math.sin(angle) };
});

type Face = { triangle: Triangle; bounds: Box3 };
type Floor = Face & { y: number; top: number };
type Cell = { faces: Face[]; floors: Floor[] };

// Index the static room once. A position query visits one cell per nearby room
// because each triangle is indexed with the visitor radius already included
function roomGrid(bounds: Box3) {
  const size = bounds.getSize(new Vector3());
  const columns = Math.max(1, Math.min(16, Math.ceil(size.x / 2)));
  const rows = Math.max(1, Math.min(16, Math.ceil(size.z / 2)));
  const cells: Cell[] = Array.from({ length: columns * rows }, () => ({ faces: [], floors: [] }));
  const column = (x: number) =>
    Math.min(columns - 1, Math.max(0, Math.floor(((x - bounds.min.x) / (size.x || 1)) * columns)));
  const row = (z: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor(((z - bounds.min.z) / (size.z || 1)) * rows)));
  return {
    at(x: number, z: number) {
      if (
        x < bounds.min.x - HALF_WIDTH ||
        x > bounds.max.x + HALF_WIDTH ||
        z < bounds.min.z - HALF_WIDTH ||
        z > bounds.max.z + HALF_WIDTH
      )
        return undefined;
      return cells[row(z) * columns + column(x)]!;
    },
    add(face: Face, floor?: Floor) {
      const box = face.bounds;
      const endX = column(box.max.x + HALF_WIDTH),
        endZ = row(box.max.z + HALF_WIDTH);
      for (let z = row(box.min.z - HALF_WIDTH); z <= endZ; z++) {
        for (let x = column(box.min.x - HALF_WIDTH); x <= endX; x++) {
          const cell = cells[z * columns + x]!;
          cell.faces.push(face);
          if (floor) cell.floors.push(floor);
        }
      }
    },
  };
}

// Use the triangles after normalization, world transforms and doorway cuts. In particular,
// the bounding box of a wall with a doorway includes the empty space under its lintel
export function createWalkSpace(rooms: readonly Object3D[]) {
  const grids: ReturnType<typeof roomGrid>[] = [];
  const floors: Floor[] = [];
  for (const room of rooms) {
    room.updateWorldMatrix(true, true);
    const roomBounds = new Box3().setFromObject(room, true);
    if (roomBounds.isEmpty()) continue;
    const grid = roomGrid(roomBounds);
    grids.push(grid);
    room.traverseVisible((node) => {
      if (!(node instanceof Mesh)) return;
      const geometry = node.geometry;
      const vertices = geometry.getAttribute("position");
      if (!vertices) return;
      const index = geometry.index;
      const points = Array.from({ length: vertices.count }, (_, i) =>
        new Vector3().fromBufferAttribute(vertices, i).applyMatrix4(node.matrixWorld),
      );
      const vertex = (i: number) => points[index ? index.getX(i) : i]!;
      for (let i = 0; i + 2 < (index?.count ?? vertices.count); i += 3) {
        const triangle = new Triangle(vertex(i), vertex(i + 1), vertex(i + 2));
        const box = new Box3().setFromPoints([triangle.a, triangle.b, triangle.c]);
        const face = { triangle, bounds: box };
        let floor: Floor | undefined;
        // Floor slabs can have reversed winding and an underside. Pick the top supporting
        // face at each point; the lower band excludes tables, ceilings and wall tops
        if (
          box.max.y - box.min.y < EPSILON &&
          box.max.y <=
            roomBounds.min.y + Math.max(0.35, (roomBounds.max.y - roomBounds.min.y) * 0.1) &&
          triangle.getArea() > EPSILON * EPSILON
        ) {
          floor = { ...face, y: box.max.y, top: roomBounds.max.y };
          floors.push(floor);
        }
        grid.add(face, floor);
      }
    });
  }

  const point = new Vector3();
  const body = new Box3();
  const axis = new Ray(new Vector3(), new Vector3(0, 1, 0));
  const head = new Vector3();
  const wallNormal = new Vector3();
  function touchesBody(triangle: Triangle) {
    // Closest features of a segment and triangle are an endpoint, an edge, or a piercing
    const radiusSq = HALF_WIDTH * HALF_WIDTH;
    if (
      triangle.closestPointToPoint(axis.origin, point).distanceToSquared(axis.origin) < radiusSq ||
      triangle.closestPointToPoint(head, point).distanceToSquared(head) < radiusSq
    )
      return true;
    const { a, b, c } = triangle;
    if (axis.intersectTriangle(a, b, c, false, point) && point.y <= head.y) return true;
    const nearEdge = (start: Vector3, end: Vector3) =>
      axis.distanceSqToSegment(start, end, point) < radiusSq && point.y <= head.y;
    return nearEdge(a, b) || nearEdge(b, c) || nearEdge(c, a);
  }
  function support(x: number, z: number, near: number) {
    let best: Floor | undefined;
    for (const grid of grids) {
      const cell = grid.at(x, z);
      if (!cell) continue;
      for (const face of cell.floors) {
        const { bounds, y, triangle } = face;
        if (
          (best && y <= best.y) ||
          y > near + MAX_STEP ||
          y < near - MAX_STEP ||
          x < bounds.min.x - EPSILON ||
          x > bounds.max.x + EPSILON ||
          z < bounds.min.z - EPSILON ||
          z > bounds.max.z + EPSILON
        )
          continue;
        if (triangle.containsPoint(point.set(x, y, z))) best = face;
      }
    }
    return best;
  }
  function clear(x: number, z: number, floor: number, eye: number) {
    body.min.set(x - HALF_WIDTH, floor + MAX_STEP + EPSILON, z - HALF_WIDTH);
    body.max.set(
      x + HALF_WIDTH,
      Math.max(floor + HEIGHT, eye + HEIGHT - EYE_HEIGHT),
      z + HALF_WIDTH,
    );
    axis.origin.set(x, body.min.y + HALF_WIDTH, z);
    head.set(x, body.max.y - HALF_WIDTH, z);
    for (const grid of grids) {
      const cell = grid.at(x, z);
      if (!cell) continue;
      for (const { bounds, triangle } of cell.faces) {
        if (body.intersectsBox(bounds) && touchesBody(triangle)) {
          triangle.getNormal(wallNormal);
          return false;
        }
      }
    }
    return true;
  }
  function standingFloor(x: number, z: number, near: number) {
    const floor = support(x, z, near);
    if (!floor) return undefined;
    // The footprint may span two supporting floors across a connected threshold
    for (const offset of footprint)
      if (!support(x + offset.x, z + offset.z, floor.y)) return undefined;
    return floor;
  }

  let currentFloor = 0;
  let eyeLimit = Infinity;
  // Open-topped rooms still have an interior. Floor-only spaces permit normal jumping
  const upperEye = (floor: Floor) =>
    floor.top >= floor.y + HEIGHT ? floor.top - (HEIGHT - EYE_HEIGHT) : floor.y + EYE_HEIGHT + 1;
  const candidate = new Vector3();
  const center = new Vector3();
  const nearest = new Vector3();
  // Unsupported geometry leaves the authored view intact and disables walking, not rendering
  function place(eye: Vector3): number | undefined {
    let best = Infinity;
    const consider = (x: number, z: number, near: number) => {
      const surface = standingFloor(x, z, near);
      if (!surface) return;
      const floor = surface.y;
      // Keep a valid authored viewpoint; bring a view inside the floor/ceiling back to standing
      let y = eye.y <= floor + EPSILON ? floor + EYE_HEIGHT : Math.min(upperEye(surface), eye.y);
      if (!clear(x, z, floor, y)) {
        y = floor + EYE_HEIGHT;
        if (!clear(x, z, floor, y)) return;
      }
      candidate.set(x, y, z);
      const distance =
        candidate.distanceToSquared(eye) + Math.abs(floor - (eye.y - EYE_HEIGHT)) * EPSILON;
      if (distance < best) {
        best = distance;
        nearest.copy(candidate);
        currentFloor = floor;
        eyeLimit = upperEye(surface);
      }
    };
    for (const floor of floors) {
      if (
        eye.x >= floor.bounds.min.x &&
        eye.x <= floor.bounds.max.x &&
        eye.z >= floor.bounds.min.z &&
        eye.z <= floor.bounds.max.z
      )
        consider(eye.x, eye.z, floor.y);
    }
    if (!Number.isFinite(best)) {
      // A saved overview can be outside or inside a wall. Try the nearest interior point
      // and triangle centers, including disconnected rooms, before allowing input
      for (const floor of floors) {
        floor.triangle.getMidpoint(center);
        floor.triangle.closestPointToPoint(eye, point);
        const distance = point.distanceTo(center);
        if (distance > 0) point.lerp(center, Math.min(1, (HALF_WIDTH * 3) / distance));
        consider(point.x, point.z, floor.y);
        consider(center.x, center.z, floor.y);
      }
    }
    if (!Number.isFinite(best)) return undefined;
    eye.copy(nearest);
    return currentFloor;
  }
  function move(from: Vector3, to: Vector3, eyeClearance = EYE_HEIGHT) {
    // FpsControls submits fixed physics steps (< 3 cm even when sprinting)
    let x = from.x;
    let z = from.z;
    const tryMove = (nextX: number, nextZ: number) => {
      const floor = standingFloor(nextX, nextZ, currentFloor);
      if (!floor || !clear(nextX, nextZ, floor.y, from.y)) return false;
      currentFloor = floor.y;
      eyeLimit = upperEye(floor);
      x = nextX;
      z = nextZ;
      return true;
    };
    if (to.x !== x || to.z !== z) {
      wallNormal.set(0, 0, 0);
      if (!tryMove(to.x, to.z)) {
        const dx = to.x - x,
          dz = to.z - z;
        wallNormal.setY(0).normalize();
        const inward = dx * wallNormal.x + dz * wallNormal.z;
        if (!inward || !tryMove(to.x - inward * wallNormal.x, to.z - inward * wallNormal.z)) {
          if (dx) tryMove(x + dx, z);
          if (dz) tryMove(x, z + dz);
        }
      }
    }
    let y = Math.min(eyeLimit, Math.max(to.y, currentFloor + eyeClearance));
    if (y > from.y && !clear(x, z, currentFloor, y))
      y = Math.max(from.y, currentFloor + eyeClearance);
    to.set(x, y, z);
    return currentFloor;
  }
  return { place, move };
}
