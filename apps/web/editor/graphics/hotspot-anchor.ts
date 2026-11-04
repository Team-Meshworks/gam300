import { Box3, Vector3, type Object3D, type PerspectiveCamera } from "three";
import type { Vector3Tuple } from "../../shared/project/scene-object";

export const HOTSPOT_SIZE = 0.6;

export function hotspotWorldSize(owner: Object3D): number {
  const scale = owner.getWorldScale(new Vector3());
  return HOTSPOT_SIZE * Math.min(Math.abs(scale.x), Math.abs(scale.y));
}

/** Attach just outside the visible upper-left corner, then preserve that local point.
 * The immutable catalogue bounds exclude captions and previously attached markers.
 * Project all corners so rotation, perspective and nonuniform scale cannot swap sides.
 */
export function hotspotAnchor(
  model: Object3D,
  owner: Object3D,
  camera: PerspectiveCamera,
): Vector3Tuple | undefined {
  const bounds = new Box3().setFromObject(model);
  const size = bounds.getSize(new Vector3());
  if (
    bounds.isEmpty() ||
    ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite) ||
    size.lengthSq() === 0
  )
    return;
  owner.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);
  const projected = new Box3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new Vector3(x, y, z).applyMatrix4(owner.matrixWorld);
        // A model crossing the camera plane has no finite visible corner to anchor to.
        if (point.clone().applyMatrix4(camera.matrixWorldInverse).z >= -camera.near) return;
        projected.expandByPoint(point.project(camera));
      }
    }
  }
  // Use a common plane at the nearest model depth. Perspective then gives a precise
  // visible edge, even when that edge comes from a different corner than the top.
  const topLeft = new Vector3(projected.min.x, projected.max.y, projected.min.z)
    .unproject(camera)
    .applyMatrix4(camera.matrixWorldInverse);
  const bottomRight = new Vector3(projected.max.x, projected.min.y, projected.min.z)
    .unproject(camera)
    .applyMatrix4(camera.matrixWorldInverse);
  const gap = Math.max(bottomRight.x - topLeft.x, topLeft.y - bottomRight.y) * 0.04;
  const markerSize = hotspotWorldSize(owner);
  topLeft.x -= gap + markerSize / 2;
  topLeft.y += gap + markerSize / 2;
  const local = owner.worldToLocal(topLeft.applyMatrix4(camera.matrixWorld));
  // Existing documents store the bottom centre; syncHotspots adds this local offset.
  local.y -= HOTSPOT_SIZE / 2;
  return local.toArray() as Vector3Tuple;
}
