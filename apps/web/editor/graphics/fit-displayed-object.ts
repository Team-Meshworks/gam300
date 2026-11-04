import * as THREE from "three";
import type { ProjectObject, Transform } from "../../shared/project/project-types";

export function fitDisplayedObject(
  owner: ProjectObject,
  top: number,
  caseBounds: THREE.Box3,
  modelBounds: THREE.Box3,
): Transform {
  const space = caseBounds.getSize(new THREE.Vector3());
  const size = modelBounds.getSize(new THREE.Vector3());
  const height = caseBounds.max.y - top;
  const fit = Math.min(
    1,
    (space.x * 0.9) / size.x,
    (space.z * 0.9) / size.z,
    ((height > 0.01 ? height : Math.max(space.x, space.z)) * 0.9) / size.y,
  );
  return {
    position: new THREE.Vector3(0, top, 0)
      .multiply(new THREE.Vector3(...owner.transform.scale))
      .applyQuaternion(new THREE.Quaternion(...owner.transform.rotation))
      .add(new THREE.Vector3(...owner.transform.position))
      .toArray(),
    rotation: owner.transform.rotation,
    scale: owner.transform.scale.map((value) => value * fit) as [number, number, number],
  };
}
