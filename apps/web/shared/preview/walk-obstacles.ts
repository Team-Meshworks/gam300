import { Box3, MathUtils, Matrix3, Matrix4, Object3D, Vector3 } from "three";
import { OBB } from "three/examples/jsm/math/OBB.js";
import { walkGrid } from "./walk-grid";

// Bounds include the normalized model and its children, in the authored root's local space.
export type WalkProp = { root: Object3D; bounds: Box3 };

export function walkObstacles(props: readonly WalkProp[], radius: number) {
  const extent = new Box3();
  const boxes = props.flatMap(({ root, bounds }) => {
    if (bounds.isEmpty()) return [];
    root.updateWorldMatrix(true, false);
    const matrix = root.matrixWorld;
    const world = bounds.clone().applyMatrix4(matrix);
    extent.union(world);
    const box = new OBB(
      bounds.getCenter(new Vector3()).applyMatrix4(matrix),
      bounds
        .getSize(new Vector3())
        .multiply(new Vector3().setFromMatrixScale(matrix))
        .multiplyScalar(0.5),
      new Matrix3().setFromMatrix4(new Matrix4().extractRotation(matrix)),
    );
    const upright = Math.abs(box.rotation.elements[4]) > 1 - 1e-8;
    return [{ root, world, box, upright }];
  });
  const grid = boxes.length ? walkGrid<(typeof boxes)[number]>(extent, radius) : undefined;
  if (grid) for (const box of boxes) grid.add(box.world, box);
  const probe = new Vector3();
  const closest = new Vector3();
  return {
    boxes,
    blocks(x: number, z: number, body: Box3, normal: Vector3) {
      const cell = grid?.at(x, z);
      if (!cell) return false;
      for (const { root, world, box, upright } of cell) {
        if (!root.visible || !world.intersectsBox(body)) continue;
        // The nearest height on the visitor's spine gives an exact capsule test for upright props.
        probe.set(x, MathUtils.clamp(box.center.y, body.min.y + radius, body.max.y - radius), z);
        box.clampPoint(probe, closest);
        if (
          upright ? probe.distanceToSquared(closest) < radius * radius : box.intersectsBox3(body)
        ) {
          normal.subVectors(probe, closest);
          return true;
        }
      }
      return false;
    },
  };
}
