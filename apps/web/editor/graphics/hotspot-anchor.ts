import { Box3, Vector3, type Object3D } from "three";
import type { Vector3Tuple } from "../../shared/project/scene-object";

export const HOTSPOT_SIZE = 0.6;

/** New attachments use the model's local upper-right/front corner, never a floor hit.
 * Read the immutable catalogue model so captions, other exhibits and existing markers
 * cannot change the anchor. The owner supplies its translation, rotation and scale.
 * Stored positions describe the marker's bottom centre (also used by older scenes).
 */
export function hotspotAnchor(model: Object3D): Vector3Tuple | undefined {
  const bounds = new Box3().setFromObject(model);
  const size = bounds.getSize(new Vector3());
  if (
    bounds.isEmpty() ||
    ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite) ||
    size.lengthSq() === 0
  )
    return;
  const gap = Math.max(size.x, size.y, size.z) * 0.08;
  return [bounds.max.x + gap + HOTSPOT_SIZE / 2, bounds.max.y + gap, bounds.max.z];
}
