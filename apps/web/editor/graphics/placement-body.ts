import * as THREE from "three";
import { isStarterRoomModelAsset, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { Transform } from "../../shared/project/project-types";
import { visibleModelBounds } from "./visible-model-bounds";
import type { PlacementBody } from "./placement-constraints";

const FLOOR_EPSILON = 0.0001;

export type ModelPlacementBody = PlacementBody & {
  floorAtTransform?: ReturnType<typeof createPlacementFloor>;
};

export function placementBody(
  id: string,
  transform: Transform,
  model: THREE.Object3D,
  asset: CatalogueAsset,
  roomModel = isStarterRoomModelAsset(asset),
): ModelPlacementBody {
  const bounds = visibleModelBounds(model);
  const body: ModelPlacementBody = { id, transform, bounds };
  if (asset.kind === "environment" || roomModel) {
    const interior = bounds.clone();
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const face = visibleModelBounds(node);
      if (node.name === "floor") interior.min.y = face.max.y;
      if (node.name === "Wall_Left") interior.min.x = face.max.x;
      if (node.name === "Wall_Right") interior.max.x = face.min.x;
      if (node.name === "Wall_Back") interior.min.z = face.max.z;
      if (node.name === "Wall_Front") interior.max.z = face.min.z;
    });
    body.room = interior;
    body.floorAtTransform = createPlacementFloor(model, bounds);
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

function createPlacementFloor(model: THREE.Object3D, bounds: THREE.Box3) {
  const levels = new Map<number, { y: number; triangles: THREE.Triangle[] }>();
  const floorBand = bounds.min.y + Math.max(0.35, (bounds.max.y - bounds.min.y) * 0.1);
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
    for (let i = 0; i + 2 < (geometry.index?.count ?? vertices.count); i += 3) {
      const a = vertex(i),
        b = vertex(i + 1),
        c = vertex(i + 2);
      const y = Math.max(a.y, b.y, c.y);
      if (y - Math.min(a.y, b.y, c.y) > FLOOR_EPSILON || (node.name !== "floor" && y > floorBand))
        continue;
      const triangle = new THREE.Triangle(a, b, c);
      if (triangle.getArea() <= FLOOR_EPSILON * FLOOR_EPSILON) continue;
      const key = Math.round(y / FLOOR_EPSILON);
      let level = levels.get(key);
      if (!level) {
        level = { y, triangles: [] };
        levels.set(key, level);
      }
      level.triangles.push(triangle);
    }
  });

  const topFirst = [...levels.values()].sort((a, b) => b.y - a.y);
  return (frame: THREE.Matrix4) => {
    const inverse = frame.clone().invert();
    const local = new THREE.Ray();
    const point = new THREE.Vector3();
    function intersect(ray: THREE.Ray) {
      local.copy(ray).applyMatrix4(inverse);
      if (Math.abs(local.direction.y) < 1e-12 || !local.intersectsBox(bounds)) return;
      let nearest = Infinity;
      for (const level of topFirst) {
        const y = level.y;
        const distance = (y - local.origin.y) / local.direction.y;
        if (distance < 0 || distance >= nearest) continue;
        local.at(distance, point);
        const surface = topFirst.find((candidate) => {
          point.y = candidate.y;
          return candidate.triangles.some((triangle) => triangle.containsPoint(point));
        });
        if (surface === level) nearest = distance;
      }
      if (Number.isFinite(nearest))
        return local.at(nearest, new THREE.Vector3()).applyMatrix4(frame);
    }
    function supportHeight(x: number, minimumY: number, z: number, base: THREE.Box3) {
      const above = bounds.clone().applyMatrix4(frame).max.y + 1;
      const down = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
      let highest = minimumY;
      function sample(dx: number, dz: number) {
        down.origin.set(x + dx, above, z + dz);
        const hit = intersect(down);
        if (hit) highest = Math.max(highest, hit.y);
      }
      sample(0, 0);
      for (const dx of [base.min.x, base.max.x])
        for (const dz of [base.min.z, base.max.z]) sample(dx, dz);
      return highest;
    }
    return { intersect, supportHeight };
  };
}
