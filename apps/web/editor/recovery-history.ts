import type { ProjectDocument, ProjectObject } from "../shared/project/project-types";
import { validateProject } from "../shared/project/project-validation";
import {
  checkFields,
  freezeValidatedData,
  invalid,
  isRecord,
  type ValidationResult,
} from "../shared/project/validation-helpers";

type Objects = readonly ProjectObject[];
export type RecoveryHistory = Readonly<{
  version: 1;
  projectId: string;
  sceneId: string;
  current: Objects;
  past: readonly Objects[];
  future: readonly Objects[];
}>;

export const MAX_HISTORY_BYTES = 20 * 1024 * 1024;

// Whole object-list snapshots cover deletion, ordering and copies without serializing closures
// This is local recovery data only; it never enters the portable project format
export function captureRecoveryHistory(
  project: ProjectDocument,
  states: { past: Objects[]; future: Objects[] },
): RecoveryHistory {
  const scene = project.scenes[0]!;
  const result: RecoveryHistory = {
    version: 1,
    projectId: project.projectId,
    sceneId: scene.id,
    current: scene.objects,
    past: [...states.past],
    future: [...states.future],
  };

  // Keep the closest edits when a large project exceeds the recovery budget
  const past = result.past as Objects[];
  const future = result.future as Objects[];
  while (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_HISTORY_BYTES &&
    past.length + future.length > 0
  ) {
    if (past.length >= future.length) {
      past.pop();
    } else {
      future.pop();
    }
  }
  return result;
}

export function validateRecoveryHistory(
  raw: unknown,
  project: ProjectDocument,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<RecoveryHistory> {
  // Check ownership and bounds before rebuilding any snapshots from browser storage
  if (!isRecord(raw)) {
    return invalid("history", "Recovery history must be an object");
  }
  const fields = checkFields(
    raw,
    ["version", "projectId", "sceneId", "current", "past", "future"],
    "history",
  );
  if (!fields.ok) {
    return fields;
  }
  const scene = project.scenes[0]!;
  if (raw.version !== 1 || raw.projectId !== project.projectId || raw.sceneId !== scene.id) {
    return invalid("history", "Recovery history belongs to a different project or version");
  }
  if (
    !Array.isArray(raw.past) ||
    !Array.isArray(raw.future) ||
    raw.past.length + raw.future.length > 100
  ) {
    return invalid("history", "Recovery history exceeds the 100-edit limit");
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_HISTORY_BYTES) {
      return invalid("history", "Recovery history exceeds its size limit");
    }
  } catch {
    return invalid("history", "Recovery history is not serializable");
  }

  // Validate each candidate object list against the full document, retaining all other scenes
  // Freeze the separate checked copy before recovered commands can expose it to editor panels
  function readObjects(objects: unknown): ValidationResult<Objects> {
    const checked = validateProject(
      { ...project, scenes: [{ ...scene, objects }, ...project.scenes.slice(1)] },
      assetKinds,
    );
    if (!checked.ok) {
      return checked;
    }
    const result = checked.value.scenes[0]!.objects;
    return { ok: true, value: freezeValidatedData(result) };
  }

  // The history's current snapshot must describe the same normalized data as the saved scene
  // Reject mismatches before restoring either stack so undo cannot introduce unrelated state
  const current = readObjects(raw.current);
  const expected = readObjects(scene.objects);
  if (!current.ok) {
    return current;
  }
  if (!expected.ok) {
    return expected;
  }
  if (JSON.stringify(current.value) !== JSON.stringify(expected.value)) {
    return invalid("history", "Recovery history does not match the saved scene");
  }

  // Rebuild both stacks in saved order and reject the whole history if any entry is invalid
  const past: Objects[] = [];
  const future: Objects[] = [];
  for (const [input, output] of [
    [raw.past, past],
    [raw.future, future],
  ] as const) {
    for (const state of input) {
      const checked = readObjects(state);
      if (!checked.ok) {
        return checked;
      }
      output.push(checked.value);
    }
  }
  // Publish only the fully checked immutable history; the caller still decides whether to install it
  return {
    ok: true,
    value: Object.freeze({
      version: 1,
      projectId: project.projectId,
      sceneId: scene.id,
      current: current.value,
      past: Object.freeze(past),
      future: Object.freeze(future),
    }),
  };
}
