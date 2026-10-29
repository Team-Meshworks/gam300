import type { ProjectDocument, ProjectObject } from "../shared/project/project-types";
import type { ProjectViewpoint as NamedViewpoint } from "../shared/project/project-content";
import { validateProject } from "../shared/project/project-validation";
import {
  checkFields,
  freezeValidatedData,
  invalid,
  isRecord,
  type ValidationResult,
} from "../shared/project/validation-helpers";

export type ProjectHistoryState = Readonly<{ project: ProjectDocument; activeSceneId: string }>;

function firstViews(project: ProjectDocument): readonly NamedViewpoint[] {
  return project.schemaVersion === 2 ? project.scenes[0]!.viewpoints : [];
}

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

// Whole object-list snapshots cover deletion, ordering and copies without serializing closures
// This is local recovery data only; it never enters the portable project format
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
            current: firstViews(project),
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

  // Keep the closest edits when a large project exceeds the recovery budget
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
  // Check ownership and bounds before rebuilding any snapshots from browser storage
  if (!isRecord(raw)) {
    return invalid("history", "Recovery history must be an object");
  }
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
    // Full documents carry references across scenes. Check compatibility copies against
    // those validated documents instead of stripping scenes and breaking their links.
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(raw.current, project.scenes[0]!.objects))
      return invalid("history", "Recovery history does not match the saved scene");
    const viewCopies = raw.views;
    if (
      viewCopies !== undefined &&
      (!isRecord(viewCopies) ||
        !Array.isArray(viewCopies.past) ||
        !Array.isArray(viewCopies.future) ||
        viewCopies.past.length !== past.length ||
        viewCopies.future.length !== future.length ||
        !same(viewCopies.current, firstViews(project)))
    )
      return invalid("history.views", "Viewpoint history does not match the saved scene");
    if (isRecord(viewCopies)) {
      const fields = checkFields(viewCopies, ["current", "past", "future"], "history.views");
      if (!fields.ok) return fields;
    }
    for (const [entries, copies, views] of [
      [past, raw.past, isRecord(viewCopies) ? viewCopies.past : undefined],
      [future, raw.future, isRecord(viewCopies) ? viewCopies.future : undefined],
    ] as const) {
      if (
        entries.some(
          (entry, i) =>
            !same(entry.project.scenes[0]!.objects, copies[i]) ||
            (Array.isArray(views) && !same(firstViews(entry.project), views[i])),
        )
      )
        return invalid("history.documents", "Saved history copies do not match");
    }
    return {
      ok: true,
      value: freezeValidatedData({
        version: 1,
        projectId: project.projectId,
        sceneId: scene.id,
        current: project.scenes[0]!.objects,
        past: past.map((s) => s.project.scenes[0]!.objects),
        future: future.map((s) => s.project.scenes[0]!.objects),
        ...(viewCopies ? { views: viewCopies as RecoveryHistory["views"] } : {}),
        documents: {
          current: current.value.project,
          activeSceneId: current.value.activeSceneId,
          past,
          future,
        },
      } as RecoveryHistory),
    };
  }
  if (raw.views !== undefined && project.scenes.length > 1)
    return invalid("history", "Scene-authoring history requires full document snapshots");
  if (raw.views !== undefined && project.schemaVersion === 1)
    return invalid("history.views", "Older scene history needs compatibility import");

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
    if (JSON.stringify(firstViews(current.value)) !== JSON.stringify(firstViews(project)))
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
        output.push(firstViews(checked.value));
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
      current: freezeViews(firstViews(current.value)),
      past: Object.freeze(past.map(freezeViews)),
      future: Object.freeze(future.map(freezeViews)),
    });
  }
  function readObjects(
    objects: unknown,
    viewpoints?: readonly NamedViewpoint[],
  ): ValidationResult<Objects> {
    // Reuse project checks for IDs, references, transforms and the object-count limit.
    const checked = validateProject(
      {
        ...project,
        scenes: [
          { ...scene, objects, ...(viewpoints ? { viewpoints } : {}) },
          ...project.scenes.slice(1),
        ],
      },
      assetKinds,
    );
    if (!checked.ok) return checked;
    const result = checked.value.scenes[0]!.objects;
    return { ok: true, value: freezeValidatedData(result) };
  }

  // The history's current snapshot must describe the same normalized data as the saved scene
  // Reject mismatches before restoring either stack so undo cannot introduce unrelated state
  const current = readObjects(raw.current, views?.current);
  const expected = readObjects(scene.objects, views?.current);
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
  for (const [input, output, viewpoints] of [
    [raw.past, past, views?.past],
    [raw.future, future, views?.future],
  ] as const) {
    for (const [i, state] of input.entries()) {
      const checked = readObjects(state, viewpoints?.[i]);
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
    // Do not trim these copies separately from their authoritative documents.
    const legacy: RecoveryHistory = {
      version: 1,
      projectId: project.projectId,
      sceneId: project.scenes[0]!.id,
      current: project.scenes[0]!.objects,
      past: past.map((s) => first(s).objects),
      future: future.map((s) => first(s).objects),
      ...(project.schemaVersion === 2
        ? {
            views: {
              current: firstViews(project),
              past: past.map((s) => firstViews(s.project)),
              future: future.map((s) => firstViews(s.project)),
            },
          }
        : {}),
    };
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
