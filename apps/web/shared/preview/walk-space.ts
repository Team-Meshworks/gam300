import { Box3, Mesh, Object3D, Ray, Triangle, Vector3 } from "three";
import { walkGrid } from "./walk-grid";
import { walkObstacles, type WalkProp } from "./walk-obstacles";
export type { WalkProp } from "./walk-obstacles";

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
type RoomGrid = {
  faces: ReturnType<typeof walkGrid<Face>>;
  floors: ReturnType<typeof walkGrid<Floor>>;
};
type Support = Pick<Floor, "y" | "top">;

// Use the triangles after normalization, world transforms and doorway cuts. In particular,
// the bounding box of a wall with a doorway includes the empty space under its lintel
export function createWalkSpace(rooms: readonly Object3D[], props: readonly WalkProp[] = []) {
  const obstacles = walkObstacles(props, HALF_WIDTH);
  const openGround = !rooms.length && obstacles.boxes.length ? { y: 0, top: Infinity } : undefined;
  const grids: RoomGrid[] = [];
  const floors: Floor[] = [];
  for (const room of rooms) {
    room.updateWorldMatrix(true, true);
    const roomBounds = new Box3().setFromObject(room, true);
    if (roomBounds.isEmpty()) continue;
    const grid = {
      faces: walkGrid<Face>(roomBounds, HALF_WIDTH),
      floors: walkGrid<Floor>(roomBounds, HALF_WIDTH),
    };
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
        // Floor slabs can have reversed winding and an underside. Pick the top supporting
        // face at each point; the lower band excludes tables, ceilings and wall tops
        if (
          box.max.y - box.min.y < EPSILON &&
          box.max.y <=
            roomBounds.min.y + Math.max(0.35, (roomBounds.max.y - roomBounds.min.y) * 0.1) &&
          triangle.getArea() > EPSILON * EPSILON
        ) {
          const floor = { ...face, y: box.max.y, top: roomBounds.max.y };
          floors.push(floor);
          grid.floors.add(box, floor);
        }
        grid.faces.add(box, face);
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
      const cell = grid.floors.at(x, z);
      if (!cell) continue;
      for (const face of cell) {
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
  function setBody(x: number, z: number, floor: number, eye: number) {
    body.min.set(x - HALF_WIDTH, floor + EPSILON, z - HALF_WIDTH);
    body.max.set(
      x + HALF_WIDTH,
      Math.max(floor + HEIGHT, eye + HEIGHT - EYE_HEIGHT),
      z + HALF_WIDTH,
    );
  }
  function clear(x: number, z: number, floor: number, eye: number) {
    setBody(x, z, floor, eye);
    if (obstacles.blocks(x, z, body, wallNormal)) return false;
    body.min.y += MAX_STEP;
    axis.origin.set(x, body.min.y + HALF_WIDTH, z);
    head.set(x, body.max.y - HALF_WIDTH, z);
    for (const grid of grids) {
      const cell = grid.faces.at(x, z);
      if (!cell) continue;
      for (const { bounds, triangle } of cell) {
        if (body.intersectsBox(bounds) && touchesBody(triangle)) {
          triangle.getNormal(wallNormal);
          return false;
        }
      }
    }
    return true;
  }
  function standingFloor(x: number, z: number, near: number) {
    if (openGround) return openGround;
    const floor = support(x, z, near);
    if (!floor) return undefined;
    // The footprint may span two supporting floors across a connected threshold
    for (const offset of footprint)
      if (!support(x + offset.x, z + offset.z, floor.y)) return undefined;
    return floor;
  }

  let currentFloor = 0;
  function insideProp(eye: Vector3) {
    setBody(eye.x, eye.z, currentFloor, eye.y);
    return obstacles.blocks(eye.x, eye.z, body, wallNormal);
  }
  let eyeLimit = Infinity;
  // Open-topped rooms still have an interior. Floor-only spaces permit normal jumping
  const upperEye = (floor: Support) =>
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
      let y = Math.min(upperEye(surface), eye.y);
      if (!openGround && y <= floor + EPSILON) y = floor + EYE_HEIGHT;
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
    const considerAt = (x: number, z: number) => {
      if (openGround) consider(x, z, openGround.y);
      for (const grid of grids) {
        const cell = grid.floors.at(x, z);
        if (!cell) continue;
        for (const { bounds, y } of cell) {
          if (x >= bounds.min.x && x <= bounds.max.x && z >= bounds.min.z && z <= bounds.max.z)
            consider(x, z, y);
        }
      }
    };
    considerAt(eye.x, eye.z);
    if (!Number.isFinite(best)) {
      // A saved view or a newly revealed exhibit may enclose the visitor. Try its outside edges.
      const gap = HALF_WIDTH + EPSILON;
      for (const { root, world } of obstacles.boxes) {
        if (!root.visible) continue;
        considerAt(world.min.x - gap, eye.z);
        considerAt(world.max.x + gap, eye.z);
        considerAt(eye.x, world.min.z - gap);
        considerAt(eye.x, world.max.z + gap);
      }
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
  return { place, move, insideProp };
}
