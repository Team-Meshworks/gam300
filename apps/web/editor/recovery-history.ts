import type {
  ProjectDocument,
  ProjectObject,
  NamedViewpoint,
} from "../shared/project/project-types";
import { validateProject } from "../shared/project/project-validation";
import {
  checkFields,
  invalid,
  isRecord,
  type ValidationResult,
} from "../shared/project/validation-helpers";

export type ProjectHistoryState = { project: ProjectDocument; activeSceneId: string };

type Objects = readonly ProjectObject[];
export type RecoveryHistory = Readonly<{
  version: 1;
  documents?: {
    activeSceneId: string;
    current: ProjectDocument;
    past: readonly ProjectHistoryState[];
    future: readonly ProjectHistoryState[];
  };
  views?: {
    current: readonly NamedViewpoint[];
    past: readonly (readonly NamedViewpoint[])[];
    future: readonly (readonly NamedViewpoint[])[];
  };
  projectId: string;
  sceneId: string;
  current: Objects;
  past: readonly Objects[];
  future: readonly Objects[];
}>;

export const MAX_HISTORY_BYTES = 20 * 1024 * 1024;

// Whole object-list snapshots also cover deletion, ordering and copies without serializing closures.
// This is local recovery data only; it never enters the portable project format.
export function captureRecoveryHistory(
  project: ProjectDocument,
  states: { past: Objects[]; future: Objects[] },
  views?: { past: (readonly NamedViewpoint[])[]; future: (readonly NamedViewpoint[])[] },
): RecoveryHistory {
  const scene = project.scenes[0]!;
  const result: RecoveryHistory = {
    version: 1,
    ...(views
      ? {
          views: {
            current: scene.viewpoints ?? [],
            past: [...views.past],
            future: [...views.future],
          },
        }
      : {}),
    projectId: project.projectId,
    sceneId: scene.id,
    current: scene.objects,
    past: [...states.past],
    future: [...states.future],
  };
  // Keep the closest edits when a large project exceeds the recovery budget.
  const past = result.past as Objects[];
  const future = result.future as Objects[];
  while (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_HISTORY_BYTES &&
    past.length + future.length > 0
  ) {
    if (past.length >= future.length) {
      past.pop();
      (result.views?.past as unknown[] | undefined)?.pop();
    } else {
      future.pop();
      (result.views?.future as unknown[] | undefined)?.pop();
    }
  }
  return result;
}

export function validateRecoveryHistory(
  raw: unknown,
  project: ProjectDocument,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<RecoveryHistory> {
  if (!isRecord(raw)) return invalid("history", "Recovery history must be an object");
  const fields = checkFields(
    raw,
    [
      "version",
      "projectId",
      "sceneId",
      "current",
      "past",
      "future",
      ...(Object.hasOwn(raw, "views") ? ["views"] : []),
      ...(Object.hasOwn(raw, "documents") ? ["documents"] : []),
    ],
    "history",
  );
  if (!fields.ok) return fields;
  const scene = project.scenes[0]!;
  if (raw.version !== 1 || raw.projectId !== project.projectId || raw.sceneId !== scene.id)
    return invalid("history", "Recovery history belongs to a different project or version");
  if (
    !Array.isArray(raw.past) ||
    !Array.isArray(raw.future) ||
    raw.past.length + raw.future.length > 100
  )
    return invalid("history", "Recovery history exceeds the 100-edit limit");
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_HISTORY_BYTES)
      return invalid("history", "Recovery history exceeds its size limit");
  } catch {
    return invalid("history", "Recovery history is not serializable");
  }
  if (Object.hasOwn(raw, "documents")) {
    const docs = raw.documents;
    if (!isRecord(docs)) return invalid("history.documents", "Invalid document history");
    const fields = checkFields(
      docs,
      ["activeSceneId", "current", "past", "future"],
      "history.documents",
    );
    if (!fields.ok) return fields;
    if (
      !Array.isArray(docs.past) ||
      !Array.isArray(docs.future) ||
      docs.past.length + docs.future.length > 100 ||
      docs.past.length !== raw.past.length ||
      docs.future.length !== raw.future.length
    )
      return invalid("history.documents", "Document history does not match the edit history");
    function read(value: unknown): ValidationResult<ProjectHistoryState> {
      if (!isRecord(value)) return invalid("history.documents", "Invalid saved edit");
      const fields = checkFields(value, ["project", "activeSceneId"], "history.documents");
      if (!fields.ok) return fields;
      const checked = validateProject(value.project, assetKinds);
      if (!checked.ok) return checked;
      if (
        checked.value.projectId !== project.projectId ||
        typeof value.activeSceneId !== "string" ||
        !checked.value.scenes.some((s) => s.id === value.activeSceneId)
      )
        return invalid(
          "history.documents",
          "Saved edit belongs to a different project or missing scene",
        );
      return { ok: true, value: { project: checked.value, activeSceneId: value.activeSceneId } };
    }
    const current = read({ project: docs.current, activeSceneId: docs.activeSceneId });
    if (!current.ok) return current;
    if (JSON.stringify(current.value.project) !== JSON.stringify(project))
      return invalid("history.documents", "History does not match the saved project");
    const past: ProjectHistoryState[] = [],
      future: ProjectHistoryState[] = [];
    for (const [input, output] of [
      [docs.past, past],
      [docs.future, future],
    ] as const) {
      for (const item of input) {
        const checked = read(item);
        if (!checked.ok) return checked;
        output.push(checked.value);
      }
    }
    // Validate the compatibility object/view snapshots too, so corruption is never silently ignored.
    const legacy = { ...raw };
    delete legacy.documents;
    const firstScene = { ...project.scenes[0]! };
    delete firstScene.startViewpointId;
    const legacyProject = { ...project, scenes: [firstScene] };
    const compatible = validateRecoveryHistory(legacy, legacyProject, assetKinds);
    if (!compatible.ok) return compatible;
    for (const [entries, objects, views] of [
      [past, compatible.value.past, compatible.value.views?.past],
      [future, compatible.value.future, compatible.value.views?.future],
    ] as const) {
      if (
        entries.some((entry, index) => {
          const first = entry.project.scenes[0]!;
          return (
            JSON.stringify(first.objects) !== JSON.stringify(objects[index]) ||
            JSON.stringify(first.viewpoints ?? []) !== JSON.stringify(views?.[index] ?? [])
          );
        })
      )
        return invalid("history.documents", "Saved history copies do not match");
    }
    return {
      ok: true,
      value: {
        ...compatible.value,
        documents: {
          activeSceneId: current.value.activeSceneId,
          current: current.value.project,
          past,
          future,
        },
      },
    };
  }
  if (project.scenes.length !== 1 || scene.startViewpointId !== undefined)
    return invalid("history", "Multiple scenes need complete document history");
  let views: RecoveryHistory["views"];
  if (Object.hasOwn(raw, "views")) {
    const data = raw.views;
    if (
      !isRecord(data) ||
      !Array.isArray(data.past) ||
      !Array.isArray(data.future) ||
      data.past.length !== raw.past.length ||
      data.future.length !== raw.future.length
    )
      return invalid("history.views", "Viewpoint history does not match the edit history");
    const fields = checkFields(data, ["current", "past", "future"], "history.views");
    if (!fields.ok) return fields;
    const read = (value: unknown, objects: unknown) =>
      validateProject(
        { ...project, scenes: [{ ...scene, objects, viewpoints: value }] },
        assetKinds,
      );
    const current = read(data.current, raw.current);
    if (!current.ok) return current;
    if (
      JSON.stringify(current.value.scenes[0]!.viewpoints) !== JSON.stringify(scene.viewpoints ?? [])
    )
      return invalid("history.views", "Viewpoints do not match the saved scene");
    const past: (readonly NamedViewpoint[])[] = [],
      future: (readonly NamedViewpoint[])[] = [];
    for (const [input, objects, output] of [
      [data.past, raw.past, past],
      [data.future, raw.future, future],
    ] as const) {
      for (const [i, value] of input.entries()) {
        const checked = read(value, objects[i]);
        if (!checked.ok) return checked;
        output.push(checked.value.scenes[0]!.viewpoints!);
      }
    }
    function freezeViews(list: readonly NamedViewpoint[]) {
      for (const view of list) {
        Object.freeze(view.camera.position);
        Object.freeze(view.camera.rotation);
        Object.freeze(view.camera);
        Object.freeze(view);
      }
      return Object.freeze(list);
    }
    views = Object.freeze({
      current: freezeViews(current.value.scenes[0]!.viewpoints!),
      past: Object.freeze(past.map(freezeViews)),
      future: Object.freeze(future.map(freezeViews)),
    });
  }
  function readObjects(objects: unknown): ValidationResult<Objects> {
    // Reuse project checks for IDs, references, transforms and the object-count limit.
    const checked = validateProject(
      { ...project, scenes: [{ ...scene, objects, ...(views ? { viewpoints: [] } : {}) }] },
      assetKinds,
    );
    if (!checked.ok) return checked;
    const result = checked.value.scenes[0]!.objects;
    for (const object of result) {
      Object.freeze(object.transform.position);
      Object.freeze(object.transform.rotation);
      Object.freeze(object.transform.scale);
      Object.freeze(object.transform);
      Object.freeze(object);
    }
    return { ok: true, value: Object.freeze(result) };
  }
  const current = readObjects(raw.current);
  const expected = readObjects(scene.objects);
  if (!current.ok) return current;
  if (!expected.ok) return expected;
  if (JSON.stringify(current.value) !== JSON.stringify(expected.value))
    return invalid("history", "Recovery history does not match the saved scene");
  const past: Objects[] = [];
  const future: Objects[] = [];
  for (const [input, output] of [
    [raw.past, past],
    [raw.future, future],
  ] as const) {
    for (const state of input) {
      const checked = readObjects(state);
      if (!checked.ok) return checked;
      output.push(checked.value);
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      version: 1,
      ...(views ? { views } : {}),
      projectId: project.projectId,
      sceneId: scene.id,
      current: current.value,
      past: Object.freeze(past),
      future: Object.freeze(future),
    }),
  };
}

export function captureProjectHistory(
  project: ProjectDocument,
  activeSceneId: string,
  states: { past: ProjectHistoryState[]; future: ProjectHistoryState[] },
): RecoveryHistory {
  const past = [...states.past],
    future = [...states.future];
  function build(): RecoveryHistory {
    // The compatibility snapshots describe the first scene at each point in history.
    const first = (s: ProjectHistoryState) => s.project.scenes[0]!;
    const legacy = captureRecoveryHistory(
      project,
      { past: past.map((s) => first(s).objects), future: future.map((s) => first(s).objects) },
      {
        past: past.map((s) => first(s).viewpoints ?? []),
        future: future.map((s) => first(s).viewpoints ?? []),
      },
    );
    return {
      ...legacy,
      documents: { current: project, activeSceneId, past: [...past], future: [...future] },
    };
  }
  let result = build();
  while (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_HISTORY_BYTES &&
    past.length + future.length > 0
  ) {
    if (past.length >= future.length) past.pop();
    else future.pop();
    result = build();
  }
  return result;
}
