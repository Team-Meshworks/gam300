import type { ProjectObject, QuaternionTuple, Transform } from "./project-types";
import type { ContentObject, ProjectGroup } from "./project-content";
import { validateTransform } from "./spatial-validation";
import { freezeValidatedData, invalid, type ValidationResult } from "./validation-helpers";

// Compose the parent rotation delta with each saved child orientation
function multiply(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  const [x, y, z, w] = a;
  const [u, v, s, t] = b;
  return [
    w * u + x * t + y * s - z * v,
    w * v - x * s + y * t + z * u,
    w * s + x * v - y * u + z * t,
    w * t - x * u - y * v - z * s,
  ];
}

// Saved transforms remain world-space so existing readers and the player can render them directly
// Object parentage supplies attachment; folders can sit anywhere along the parent chain
export function moveAttachedObjects(
  objects: readonly ProjectObject[],
  groups: readonly ProjectGroup[],
  id: string,
  after: Transform,
): ValidationResult<readonly ProjectObject[]> {
  const root = objects.find((object) => object.id === id);
  if (!root) return invalid("objectId", "Choose an object in this scene");
  // Resolve ancestry once, including folders that have no rendered transform
  const parents = new Map(
    [...groups, ...objects].map((entry) => [
      entry.id.toLowerCase(),
      (entry as ContentObject | ProjectGroup).parentId?.toLowerCase(),
    ]),
  );
  // Stop on repeated IDs so malformed ancestry cannot trap a preview in a loop
  const attached = (object: ProjectObject) => {
    let parent = parents.get(object.id.toLowerCase());
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === id.toLowerCase()) return true;
      seen.add(parent);
      parent = parents.get(parent);
    }
    return false;
  };
  const children = new Set(objects.filter(attached).map((object) => object.id));

  // A rigid rotation plus uniform resizing preserves child shapes without introducing shear
  // Reject unequal scale changes while attached instead of silently distorting saved geometry
  const ratios = after.scale.map((value, index) => value / root.transform.scale[index]!);
  const factor = ratios[0]!;
  if (children.size && ratios.some((value) => Math.abs(value - factor) > 1e-9)) {
    return invalid("transform.scale", "Resize attached objects uniformly or detach them first");
  }
  // Convert the old parent orientation into the new one, then apply that delta around its pivot
  const [x, y, z, w] = root.transform.rotation;
  const rotation = multiply(after.rotation, [-x, -y, -z, w]);
  const inverse: QuaternionTuple = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
  const next: ProjectObject[] = [];
  for (const object of objects) {
    if (object.id === id) {
      next.push({ ...object, transform: after });
    } else if (children.has(object.id)) {
      // Apply the parent's world-space delta once to each descendant, including nested attachments
      const offset = object.transform.position.map(
        (value, index) => (value - root.transform.position[index]!) * factor,
      );
      const moved = multiply(multiply(rotation, [offset[0]!, offset[1]!, offset[2]!, 0]), inverse);
      const transform = validateTransform(
        {
          position: moved.slice(0, 3).map((value, index) => value + after.position[index]!),
          rotation: multiply(rotation, object.transform.rotation),
          scale: object.transform.scale.map((value) => value * factor),
        },
        "attached.transform",
      );
      if (!transform.ok) return transform;
      next.push({ ...object, transform: transform.value });
    } else {
      next.push(object);
    }
  }
  // Freeze the whole candidate before either a preview or an undo command can retain it
  return { ok: true, value: freezeValidatedData(next) };
}
