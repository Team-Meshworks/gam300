import type { ProjectObject, Vector3Tuple } from "../shared/project/project-types";

// Surface coordinates are local to the normalized GLB; saved object transforms are world-space.
export function displayPosition(object: ProjectObject, height: number): Vector3Tuple {
  const [x, y, z, w] = object.transform.rotation;
  const distance = height * object.transform.scale[1];
  return [
    object.transform.position[0] + 2 * (x * y - w * z) * distance,
    object.transform.position[1] + (1 - 2 * (x * x + z * z)) * distance,
    object.transform.position[2] + 2 * (y * z + w * x) * distance,
  ];
}
