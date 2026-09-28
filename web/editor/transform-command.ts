import type { EditCommand } from "./command-history";
import type { ProjectObject, Transform } from "../shared/project/project-types";
import { validateTransform } from "../shared/project/spatial-validation";
import {
  checkFields,
  invalid,
  isRecord,
  type ValidationResult,
} from "../shared/project/validation-helpers";

// The gizmo keeps its preview separate and sends one request when the drag ends.
export type TransformEdit = Readonly<{ objectId: string; before: Transform; after: Transform }>;

function sameTransform(a: Transform, b: Transform): boolean {
  const sameRotation = (sign: number) =>
    a.rotation.every((v, i) => Math.abs(v - sign * b.rotation[i]!) <= 1e-12);
  // q and -q describe the same rotation. Ignore only tiny normalization noise.
  return (
    a.position.every((v, i) => v === b.position[i]) &&
    a.scale.every((v, i) => v === b.scale[i]) &&
    (sameRotation(1) || sameRotation(-1))
  );
}

function freezeTransform(transform: Transform): Transform {
  Object.freeze(transform.position);
  Object.freeze(transform.rotation);
  Object.freeze(transform.scale);
  return Object.freeze(transform);
}

export function prepareTransformCommand(
  objects: readonly ProjectObject[],
  input: unknown,
): ValidationResult<{
  object: ProjectObject;
  command: EditCommand<readonly ProjectObject[]> | null;
}> {
  if (!isRecord(input)) return invalid("edit", "Expected a transform edit");
  const fields = checkFields(input, ["objectId", "before", "after"], "edit");
  if (!fields.ok) return fields;
  if (typeof input.objectId !== "string") return invalid("edit.objectId", "Expected an object ID");
  const original = objects.find((object) => object.id === input.objectId);
  if (!original) return invalid("edit.objectId", "This object is no longer in the scene");
  const before = validateTransform(input.before, "edit.before");
  if (!before.ok) return before;
  const after = validateTransform(input.after, "edit.after");
  if (!after.ok) return after;
  // Don't let a drag that started earlier overwrite a newer edit to this object.
  if (!sameTransform(original.transform, before.value))
    return invalid(
      "edit.before",
      "The object changed since this edit started; start again from its current transform",
    );
  if (sameTransform(original.transform, after.value))
    return { ok: true, value: { object: original, command: null } };
  // Validation made fresh arrays, so later gizmo movement cannot change history.
  const updated = Object.freeze({ ...original, transform: freezeTransform(after.value) });
  const replace = (state: readonly ProjectObject[], object: ProjectObject) =>
    Object.freeze(state.map((entry) => (entry.id === original.id ? object : entry)));
  return {
    ok: true,
    value: {
      object: updated,
      command: {
        label: "Transform object",
        apply: (state) => replace(state, updated),
        revert: (state) => replace(state, original),
      },
    },
  };
}
