import * as THREE from "three";
import { isStarterRoomModelAsset, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { Transform } from "../../shared/project/project-types";
import { visibleModelBounds } from "./visible-model-bounds";
import type { PlacementBody } from "./placement-constraints";

const FLOOR_EPSILON = 0.0001;

export function placementBody(
  id: string,
  transform: Transform,
  model: THREE.Object3D,
  asset: CatalogueAsset,
  roomModel = isStarterRoomModelAsset(asset),
): PlacementBody {
  const bounds = visibleModelBounds(model);
  const body: PlacementBody = { id, transform, bounds };
  if (asset.kind === "environment" || roomModel) {
    const interior = bounds.clone();
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const face = visibleModelBounds(node);
      if (node.name === "Wall_Left") interior.min.x = face.max.x;
      if (node.name === "Wall_Right") interior.max.x = face.min.x;
      if (node.name === "Wall_Back") interior.min.z = face.max.z;
      if (node.name === "Wall_Front") interior.max.z = face.min.z;
    });
    const floor = createPlacementFloor(model, bounds);
    if (Number.isFinite(floor.lowest)) interior.min.y = floor.lowest;
    body.room = interior;
    body.floorAtTransform = floor.atTransform;
  }
  if (asset.displayRole === "physical") {
    const glass = new THREE.Box3();
    const shelves: THREE.Box3[] = [];
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      if (materials.every((material) => material.transparent && material.opacity < 0.9))
        glass.union(visibleModelBounds(node));
      else {
        const solid = visibleModelBounds(node);
        const size = solid.getSize(new THREE.Vector3());
        if (size.y < Math.min(size.x, size.z) * 0.2) shelves.push(solid);
      }
    });
    const top = asset.displayTop ?? bounds.max.y;
    body.display = { top };
    if (!glass.isEmpty()) {
      // Curated cases have 2cm side panes and roof sections up to 4.46cm thick
      glass.min.x += 0.02;
      glass.min.z += 0.02;
      glass.max.x -= 0.02;
      glass.max.z -= 0.02;
      glass.min.y = top;
      glass.max.y -= 0.05;
      for (const shelf of shelves) {
        if (
          shelf.min.y > top + 1e-5 &&
          shelf.min.x < glass.max.x &&
          shelf.max.x > glass.min.x &&
          shelf.min.z < glass.max.z &&
          shelf.max.z > glass.min.z
        )
          glass.max.y = Math.min(glass.max.y, shelf.min.y - 0.001);
      }
      body.display.interior = glass;
    }
  }
  return body;
}

function clipFloorEdge(polygon: THREE.Vector3[], axis: "x" | "z", edge: number, sign: number) {
  const clipped: THREE.Vector3[] = [];
  let previous = polygon.at(-1)!;
  for (const current of polygon) {
    const inside = (current[axis] - edge) * sign > 0;
    const previousInside = (previous[axis] - edge) * sign > 0;
    if (inside !== previousInside) {
      const t = (edge - previous[axis]) / (current[axis] - previous[axis]);
      clipped.push(previous.clone().lerp(current, t));
    }
    if (inside) clipped.push(current);
    previous = current;
  }
  return clipped;
}

function hasFootprintArea(polygon: THREE.Vector3[]) {
  const origin = polygon[0]!;
  let twiceArea = 0;
  for (let i = 2; i < polygon.length; i++) {
    const a = polygon[i - 1]!;
    const b = polygon[i]!;
    twiceArea += (a.x - origin.x) * (b.z - origin.z) - (a.z - origin.z) * (b.x - origin.x);
  }
  return Math.abs(twiceArea) > FLOOR_EPSILON * FLOOR_EPSILON;
}

function createPlacementFloor(model: THREE.Object3D, bounds: THREE.Box3) {
  const faces: { triangle: THREE.Triangle; supporting: boolean }[] = [];
  let lowest = Infinity;
  model.updateWorldMatrix(true, true);
  model.traverseVisible((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry;
    const vertices = geometry.getAttribute("position");
    if (!vertices) return;
    const points = Array.from({ length: vertices.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(node.matrixWorld),
    );
    const vertex = (i: number) => points[geometry.index ? geometry.index.getX(i) : i]!;
    const candidates: { triangle: THREE.Triangle; up: number }[] = [];
    const normal = new THREE.Vector3();
    let signedVolume = 0;
    for (let i = 0; i + 2 < (geometry.index?.count ?? vertices.count); i += 3) {
      const a = vertex(i),
        b = vertex(i + 1),
        c = vertex(i + 2);
      const triangle = new THREE.Triangle(a, b, c);
      const up = triangle.getNormal(normal).y;
      signedVolume += up * triangle.getArea() * ((a.y + b.y + c.y) / 3 - bounds.min.y);
      const belowRoomTop = Math.min(a.y, b.y, c.y) < bounds.max.y - FLOOR_EPSILON;
      candidates.push({ triangle, up: belowRoomTop ? up : 0 });
    }
    // A closed mesh's signed volume identifies its outward winding, including mirrored imports.
    const open = Math.abs(signedVolume) <= FLOOR_EPSILON ** 3;
    for (const { triangle, up } of candidates) {
      const supporting = Math.abs(up) > FLOOR_EPSILON && (open || up * signedVolume > 0);
      faces.push({ triangle, supporting });
      if (supporting) lowest = Math.min(lowest, triangle.a.y, triangle.b.y, triangle.c.y);
    }
  });

  function worldFloor(frame: THREE.Matrix4) {
    const surfaces = faces.map(({ triangle: local, supporting }) => {
      const triangle = new THREE.Triangle(
        local.a.clone().applyMatrix4(frame),
        local.b.clone().applyMatrix4(frame),
        local.c.clone().applyMatrix4(frame),
      );
      return {
        triangle,
        supporting,
        box: new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]),
      };
    });
    const point = new THREE.Vector3();
    function intersect(ray: THREE.Ray, topOnly = true) {
      let nearest = Infinity;
      let hit: THREE.Vector3 | undefined;
      for (const {
        triangle: { a, b, c },
        box,
        supporting,
      } of surfaces) {
        if (topOnly && !supporting) continue;
        if (!ray.intersectsBox(box) || !ray.intersectTriangle(a, b, c, false, point)) continue;
        const distance = point.distanceToSquared(ray.origin);
        if (distance < nearest) {
          nearest = distance;
          (hit ??= new THREE.Vector3()).copy(point);
        }
      }
      return hit;
    }
    function supportHeight(x: number, minimumY: number, z: number, footprint: THREE.Box3) {
      const up = new THREE.Ray(
        new THREE.Vector3(x, minimumY + FLOOR_EPSILON, z),
        new THREE.Vector3(0, 1, 0),
      );
      const ceiling = intersect(up, false)?.y ?? Infinity;
      const overlaps: { low: number; high: number; supporting: boolean }[] = [];
      for (const { triangle, box, supporting } of surfaces) {
        if (
          box.max.y < minimumY - FLOOR_EPSILON ||
          box.min.y >= ceiling ||
          box.max.x <= footprint.min.x + FLOOR_EPSILON ||
          box.min.x >= footprint.max.x - FLOOR_EPSILON ||
          box.max.z <= footprint.min.z + FLOOR_EPSILON ||
          box.min.z >= footprint.max.z - FLOOR_EPSILON
        )
          continue;
        let polygon = [triangle.a, triangle.b, triangle.c];
        for (const axis of ["x", "z"] as const) {
          polygon = clipFloorEdge(polygon, axis, footprint.min[axis], 1);
          polygon = clipFloorEdge(polygon, axis, footprint.max[axis], -1);
        }
        if (polygon.length && (!supporting || hasFootprintArea(polygon))) {
          const heights = polygon.map((p) => p.y);
          overlaps.push({ low: Math.min(...heights), high: Math.max(...heights), supporting });
        }
      }
      const height = footprint.max.y - footprint.min.y;
      let highest = minimumY;
      let reachable = highest + height;
      for (const { low, high, supporting } of overlaps.sort((a, b) => a.low - b.low)) {
        if (low > reachable + FLOOR_EPSILON) break;
        if (supporting) highest = Math.max(highest, high);
        reachable = Math.max(reachable, high, highest + height);
      }
      const bottom = Math.max(footprint.min.y, highest);
      const top = bottom + height;
      if (
        top > ceiling + FLOOR_EPSILON ||
        overlaps.some(({ low, high }) => low < top - FLOOR_EPSILON && high > bottom + FLOOR_EPSILON)
      )
        return;
      return highest;
    }
    return { intersect, supportHeight };
  }
  let cached: ReturnType<typeof worldFloor> | undefined;
  const lastFrame = new THREE.Matrix4();
  return {
    lowest,
    atTransform(frame: THREE.Matrix4) {
      if (!cached || !lastFrame.equals(frame)) {
        cached = worldFloor(frame);
        lastFrame.copy(frame);
      }
      return cached;
    },
  };
}
