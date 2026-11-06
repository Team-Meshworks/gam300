import * as THREE from "three";
import type { ProjectObject, Transform } from "../../shared/project/project-types";
import { resolveObjectPlacement } from "./placement-constraints";

export function fitDisplayedObject(
  owner: ProjectObject,
  top: number,
  caseBounds: THREE.Box3,
  modelBounds: THREE.Box3,
  usableInterior?: THREE.Box3,
): Transform | undefined {
  const center = caseBounds.getCenter(new THREE.Vector3());
  const rotation = new THREE.Quaternion(...owner.transform.rotation);
  const position = new THREE.Vector3(center.x, top, center.z)
    .multiply(new THREE.Vector3(...owner.transform.scale))
    .applyQuaternion(rotation)
    .add(new THREE.Vector3(...owner.transform.position));
  const modelCenter = modelBounds.getCenter(new THREE.Vector3());
  position.sub(
    new THREE.Vector3(modelCenter.x, modelBounds.min.y, modelCenter.z).applyQuaternion(rotation),
  );
  const proposed: Transform = {
    position: position.toArray(),
    rotation: owner.transform.rotation,
    scale: [1, 1, 1],
  };
  const interior =
    usableInterior ??
    (caseBounds.max.y > top + 0.01
      ? new THREE.Box3(
          new THREE.Vector3(caseBounds.min.x + 0.02, top, caseBounds.min.z + 0.02),
          new THREE.Vector3(
            caseBounds.max.x - 0.02,
            caseBounds.max.y - 0.05,
            caseBounds.max.z - 0.02,
          ),
        )
      : undefined);
  return resolveObjectPlacement(
    { id: "displayed-object", transform: proposed, bounds: modelBounds },
    proposed,
    [
      {
        id: owner.id,
        transform: owner.transform,
        bounds: caseBounds,
        display: { top, ...(interior ? { interior } : {}) },
      },
    ],
    "release",
  );
}
