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

const DRAFT_PROJECT = { allowDraftLinks: true } as const;

export type ProjectHistoryState = Readonly<{ project: ProjectDocument; activeSceneId: string }>;

function firstViews(project: ProjectDocument): readonly NamedViewpoint[] {
  return project.schemaVersion === 2 ? project.scenes[0]!.viewpoints : [];
}

type Objects = readonly ProjectObject[];
export type HierarchyState = Readonly<{
  objects: Objects;
  sceneName?: string;
  groups: readonly import("../shared/project/project-content").ProjectGroup[];
}>;
export type HistoryState = Objects | HierarchyState;
export function isHierarchyState(value: HistoryState): value is HierarchyState {
  return !Array.isArray(value);
}

// Preserve older hierarchy backups while full-document snapshots carry new scene and viewpoint edits
function sceneState(project: ProjectDocument, version: 1 | 2): HistoryState {
  const scene = project.scenes[0]!;
  return version === 2
    ? {
        objects: scene.objects,
        groups: project.schemaVersion === 2 ? project.scenes[0]!.groups : [],
        sceneName: scene.name,
      }
    : scene.objects;
}

export type RecoveryHistory = Readonly<{
  version: 1 | 2;
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
  current: HistoryState;
  past: readonly HistoryState[];
  future: readonly HistoryState[];
}>;

export const MAX_HISTORY_BYTES = 20 * 1024 * 1024;

// Whole object-list snapshots cover deletion, ordering and copies without serializing closures
// This is local recovery data only; it never enters the portable project format
export function captureRecoveryHistory(
  project: ProjectDocument,
  states: { past: HistoryState[]; future: HistoryState[] },
  views?: { past: (readonly NamedViewpoint[])[]; future: (readonly NamedViewpoint[])[] },
): RecoveryHistory {
  return trimRecoveryHistory(createRecoveryHistory(project, states, views));
}

function createRecoveryHistory(
  project: ProjectDocument,
  states: { past: HistoryState[]; future: HistoryState[] },
  views?: { past: (readonly NamedViewpoint[])[]; future: (readonly NamedViewpoint[])[] },
): RecoveryHistory {
  const scene = project.scenes[0]!;
  const normalize = (entry: HistoryState): HistoryState =>
    project.schemaVersion === 2 && !isHierarchyState(entry)
      ? {
          objects: entry,
          groups: project.schemaVersion === 2 ? project.scenes[0]!.groups : [],
          sceneName: scene.name,
        }
      : entry;
  const result: RecoveryHistory = {
    version: project.schemaVersion === 2 ? 2 : 1,
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
    current: sceneState(project, project.schemaVersion === 2 ? 2 : 1),
    past: states.past.map(normalize),
    future: states.future.map(normalize),
  };

  return result;
}

function trimRecoveryHistory(result: RecoveryHistory): RecoveryHistory {
  const encoder = new TextEncoder();
  const sizes = new WeakMap<object, number>();
  function size(value: object): number {
    let bytes = sizes.get(value);
    if (bytes === undefined) {
      bytes = encoder.encode(JSON.stringify(value)).byteLength;
      sizes.set(value, bytes);
    }
    return bytes;
  }
  // Measure the fixed envelope and each immutable snapshot once, including UTF-8 bytes
  // Each nonempty JSON array adds one comma between adjacent items
  let bytes = size({
    ...result,
    past: [],
    future: [],
    ...(result.views ? { views: { ...result.views, past: [], future: [] } } : {}),
    ...(result.documents ? { documents: { ...result.documents, past: [], future: [] } } : {}),
  });
  const groups = [
    result,
    ...(result.views ? [result.views] : []),
    ...(result.documents ? [result.documents] : []),
  ];
  const costs = { past: [] as number[], future: [] as number[] };
  for (const side of ["past", "future"] as const) {
    for (const group of groups) {
      bytes += Math.max(0, group[side].length - 1);
      group[side].forEach((item, index) => {
        const itemBytes = size(item);
        bytes += itemBytes;
        costs[side][index] = (costs[side][index] ?? 0) + itemBytes;
      });
    }
  }
  // Pop only copied lists, preserving the closest edits and synchronized compatibility data
  while (bytes > MAX_HISTORY_BYTES && result.past.length + result.future.length > 0) {
    const side = result.past.length >= result.future.length ? "past" : "future";
    const length = result[side].length;
    bytes -= costs[side].pop()! + (length > 1 ? groups.length : 0);
    for (const group of groups) (group[side] as unknown[]).pop();
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
  if (
    (raw.version !== 1 && raw.version !== 2) ||
    raw.projectId !== project.projectId ||
    raw.sceneId !== scene.id
  ) {
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
      const checked = validateProject(value.project, assetKinds, DRAFT_PROJECT);
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
    if (!same(raw.current, sceneState(project, raw.version)))
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
            !same(sceneState(entry.project, raw.version as 1 | 2), copies[i]) ||
            (Array.isArray(views) && !same(firstViews(entry.project), views[i])),
        )
      )
        return invalid("history.documents", "Saved history copies do not match");
    }
    return {
      ok: true,
      value: freezeValidatedData({
        version: raw.version,
        projectId: project.projectId,
        sceneId: scene.id,
        current: sceneState(project, raw.version),
        past: past.map((s) => sceneState(s.project, raw.version as 1 | 2)),
        future: future.map((s) => sceneState(s.project, raw.version as 1 | 2)),
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
        {
          ...project,
          scenes: [
            { ...scene, objects: isRecord(objects) ? objects.objects : objects, viewpoints: value },
            ...project.scenes.slice(1),
          ],
        },
        assetKinds,
        DRAFT_PROJECT,
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
  const version = raw.version;
  function readObjects(
    input: unknown,
    viewpoints?: readonly NamedViewpoint[],
  ): ValidationResult<HistoryState> {
    // Old histories only replaced objects; retain their existing document groups
    // New histories validate both collections together, including every parent reference
    let objects = input;
    // Older backups predate room renaming and inherit their document's scene name
    let sceneName: unknown = scene.name;
    let groups = project.schemaVersion === 2 ? project.scenes[0]!.groups : undefined;
    if (version === 2) {
      if (project.schemaVersion !== 2 || !isRecord(input)) {
        return invalid("history", "Hierarchy history requires a content scene");
      }
      const fields = checkFields(
        input,
        "sceneName" in input ? ["objects", "groups", "sceneName"] : ["objects", "groups"],
        "history.state",
      );
      if (!fields.ok) return fields;
      if ("sceneName" in input) sceneName = input.sceneName;
      objects = input.objects;
      groups = input.groups as typeof groups;
    }
    const checked = validateProject(
      {
        ...project,
        scenes: [
          {
            ...scene,
            name: sceneName,
            objects,
            ...(groups === undefined ? {} : { groups }),
            ...(viewpoints ? { viewpoints } : {}),
          },
          ...project.scenes.slice(1),
        ],
      },
      assetKinds,
      DRAFT_PROJECT,
    );
    if (!checked.ok) {
      return checked;
    }
    const result: HistoryState =
      checked.value.schemaVersion === 2
        ? {
            objects: checked.value.scenes[0]!.objects,
            groups: checked.value.scenes[0]!.groups,
            sceneName: checked.value.scenes[0]!.name,
          }
        : checked.value.scenes[0]!.objects;
    return { ok: true, value: freezeValidatedData(result) };
  }

  // The history's current snapshot must describe the same normalized data as the saved scene
  // Reject mismatches before restoring either stack so undo cannot introduce unrelated state
  const current = readObjects(raw.current, views?.current);
  const expected = readObjects(sceneState(project, raw.version), views?.current);
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
  const past: HistoryState[] = [];
  const future: HistoryState[] = [];
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
      version: project.schemaVersion === 2 ? 2 : 1,
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
  // The compatibility snapshots describe the first scene at each point in history.
  const first = (s: ProjectHistoryState) => s.project.scenes[0]!;
  const legacy = createRecoveryHistory(
    project,
    {
      past: past.map((s) => sceneState(s.project, project.schemaVersion === 2 ? 2 : 1)),
      future: future.map((s) => sceneState(s.project, project.schemaVersion === 2 ? 2 : 1)),
    },
    project.schemaVersion === 2
      ? {
          past: past.map((s) => first(s).viewpoints ?? []),
          future: future.map((s) => first(s).viewpoints ?? []),
        }
      : undefined,
  );
  return trimRecoveryHistory({
    ...legacy,
    documents: { current: project, activeSceneId, past: [...past], future: [...future] },
  });
}
