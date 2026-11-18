import type { ProjectDocument, ProjectObject } from "../shared/project/project-types";
import type { ProjectViewpoint as NamedViewpoint } from "../shared/project/project-content";
import { validateProject } from "../shared/project/project-validation";
import {
  checkFields,
  freezeValidatedData,
  invalid,
  isRecord,
  readField,
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
  const rawVersion = readField(raw, "version");
  if (
    (rawVersion !== 1 && rawVersion !== 2) ||
    readField(raw, "projectId") !== project.projectId ||
    readField(raw, "sceneId") !== scene.id
  ) {
    return invalid("history", "Recovery history belongs to a different project or version");
  }
  const version = rawVersion;
  const rawPast = readField(raw, "past");
  const rawFuture = readField(raw, "future");
  if (
    !Array.isArray(rawPast) ||
    !Array.isArray(rawFuture) ||
    rawPast.length + rawFuture.length > 100
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
  const rawCurrent = readField(raw, "current");
  const rawViews = readField(raw, "views");
  if (Object.hasOwn(raw, "documents")) {
    const docs = readField(raw, "documents");
    if (!isRecord(docs)) return invalid("history.documents", "Invalid document history");
    const fields = checkFields(
      docs,
      ["activeSceneId", "current", "past", "future"],
      "history.documents",
    );
    if (!fields.ok) return fields;
    const documentPast = readField(docs, "past");
    const documentFuture = readField(docs, "future");
    if (
      !Array.isArray(documentPast) ||
      !Array.isArray(documentFuture) ||
      documentPast.length + documentFuture.length > 100 ||
      documentPast.length !== rawPast.length ||
      documentFuture.length !== rawFuture.length
    )
      return invalid("history.documents", "Document history does not match the edit history");
    function read(value: unknown): ValidationResult<ProjectHistoryState> {
      if (!isRecord(value)) return invalid("history.documents", "Invalid saved edit");
      const fields = checkFields(value, ["project", "activeSceneId"], "history.documents");
      if (!fields.ok) return fields;
      const checked = validateProject(readField(value, "project"), assetKinds, DRAFT_PROJECT);
      if (!checked.ok) return checked;
      const activeSceneId = readField(value, "activeSceneId");
      if (
        checked.value.projectId !== project.projectId ||
        typeof activeSceneId !== "string" ||
        !checked.value.scenes.some((s) => s.id === activeSceneId)
      )
        return invalid(
          "history.documents",
          "Saved edit belongs to a different project or missing scene",
        );
      return { ok: true, value: { project: checked.value, activeSceneId } };
    }
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const document = readField(docs, "current");
    const current = read({ project: document, activeSceneId: readField(docs, "activeSceneId") });
    if (!current.ok) return current;
    if (document !== project) {
      const saved = validateProject(project, assetKinds, DRAFT_PROJECT);
      if (!saved.ok) return saved;
      if (!same(current.value.project, saved.value))
        return invalid("history.documents", "History does not match the saved project");
    }
    const past: ProjectHistoryState[] = [],
      future: ProjectHistoryState[] = [];
    for (const [input, output] of [
      [documentPast, past],
      [documentFuture, future],
    ] as const) {
      for (const item of input) {
        const checked = read(item);
        if (!checked.ok) return checked;
        output.push(checked.value);
      }
    }
    const viewCopies = isRecord(rawViews)
      ? {
          current: readField(rawViews, "current"),
          past: readField(rawViews, "past"),
          future: readField(rawViews, "future"),
        }
      : undefined;
    if (
      rawViews !== undefined &&
      (!viewCopies ||
        !Array.isArray(viewCopies.past) ||
        !Array.isArray(viewCopies.future) ||
        viewCopies.past.length !== past.length ||
        viewCopies.future.length !== future.length)
    )
      return invalid("history.views", "Viewpoint history does not match the saved scene");
    if (isRecord(rawViews)) {
      const fields = checkFields(rawViews, ["current", "past", "future"], "history.views");
      if (!fields.ok) return fields;
    }
    // Older checkpoints can retain unnormalized compatibility copies alongside a full document.
    // Use that entry's other scenes when validating a copy so cross-scene references still resolve.
    function matches(document: ProjectDocument, copy: unknown, views: unknown): boolean {
      if (
        same(copy, sceneState(document, version)) &&
        (viewCopies === undefined || same(views, firstViews(document)))
      )
        return true;
      if (
        viewCopies !== undefined &&
        (!Array.isArray(views) || (document.schemaVersion === 1 && views.length > 0))
      )
        return false;
      const checked = readSceneCopy(
        document,
        copy,
        document.schemaVersion === 2 ? views : undefined,
      );
      return checked.ok && same(checked.value, document);
    }
    if (!matches(current.value.project, rawCurrent, viewCopies?.current))
      return invalid("history", "Recovery history does not match the saved scene");
    for (const [entries, copies, views] of [
      [past, rawPast, viewCopies?.past],
      [future, rawFuture, viewCopies?.future],
    ] as const) {
      if (
        entries.some(
          (entry, i) =>
            !matches(entry.project, copies[i], Array.isArray(views) ? views[i] : undefined),
        )
      )
        return invalid("history.documents", "Saved history copies do not match");
    }
    return {
      ok: true,
      value: freezeValidatedData({
        version,
        projectId: project.projectId,
        sceneId: scene.id,
        current: sceneState(current.value.project, version),
        past: past.map((s) => sceneState(s.project, version)),
        future: future.map((s) => sceneState(s.project, version)),
        ...(viewCopies
          ? {
              views: {
                current: firstViews(current.value.project),
                past: past.map((s) => firstViews(s.project)),
                future: future.map((s) => firstViews(s.project)),
              },
            }
          : {}),
        documents: {
          current: current.value.project,
          activeSceneId: current.value.activeSceneId,
          past,
          future,
        },
      } as RecoveryHistory),
    };
  }
  if (rawViews !== undefined && project.scenes.length > 1)
    return invalid("history", "Scene-authoring history requires full document snapshots");
  if (rawViews !== undefined && project.schemaVersion === 1)
    return invalid("history.views", "Older scene history needs compatibility import");

  let views: RecoveryHistory["views"];
  if (Object.hasOwn(raw, "views")) {
    if (!isRecord(rawViews))
      return invalid("history.views", "Viewpoint history does not match the edit history");
    const viewPast = readField(rawViews, "past");
    const viewFuture = readField(rawViews, "future");
    if (
      !Array.isArray(viewPast) ||
      !Array.isArray(viewFuture) ||
      viewPast.length !== rawPast.length ||
      viewFuture.length !== rawFuture.length
    )
      return invalid("history.views", "Viewpoint history does not match the edit history");
    const fields = checkFields(rawViews, ["current", "past", "future"], "history.views");
    if (!fields.ok) return fields;
    const read = (value: unknown, objects: unknown) =>
      validateProject(
        {
          ...project,
          scenes: [
            {
              ...scene,
              objects: isRecord(objects) ? readField(objects, "objects") : objects,
              viewpoints: value,
            },
            ...project.scenes.slice(1),
          ],
        },
        assetKinds,
        DRAFT_PROJECT,
      );
    const current = read(readField(rawViews, "current"), rawCurrent);
    if (!current.ok) return current;
    if (JSON.stringify(firstViews(current.value)) !== JSON.stringify(firstViews(project)))
      return invalid("history.views", "Viewpoints do not match the saved scene");
    const past: (readonly NamedViewpoint[])[] = [],
      future: (readonly NamedViewpoint[])[] = [];
    for (const [input, objects, output] of [
      [viewPast, rawPast, past],
      [viewFuture, rawFuture, future],
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
  function readSceneCopy(
    document: ProjectDocument,
    input: unknown,
    viewpoints: unknown,
  ): ValidationResult<ProjectDocument> {
    const scene = document.scenes[0]!;
    // Old histories only replaced objects; retain their existing document groups
    // New histories validate both collections together, including every parent reference
    let objects = input;
    // Older backups predate room renaming and inherit their document's scene name
    let sceneName: unknown = scene.name;
    let groups: unknown;
    if (version === 2) {
      if (document.schemaVersion !== 2 || !isRecord(input)) {
        return invalid("history", "Hierarchy history requires a content scene");
      }
      const fields = checkFields(
        input,
        "sceneName" in input ? ["objects", "groups", "sceneName"] : ["objects", "groups"],
        "history.state",
      );
      if (!fields.ok) return fields;
      if ("sceneName" in input) sceneName = readField(input, "sceneName");
      objects = readField(input, "objects");
      groups = readField(input, "groups");
    } else {
      groups = document.schemaVersion === 2 ? document.scenes[0]!.groups : undefined;
    }
    return validateProject(
      {
        ...document,
        scenes: [
          {
            ...scene,
            name: sceneName,
            objects,
            ...(groups === undefined ? {} : { groups }),
            ...(viewpoints ? { viewpoints } : {}),
          },
          ...document.scenes.slice(1),
        ],
      },
      assetKinds,
      DRAFT_PROJECT,
    );
  }

  function readObjects(
    input: unknown,
    viewpoints?: readonly NamedViewpoint[],
  ): ValidationResult<HistoryState> {
    const checked = readSceneCopy(project, input, viewpoints);
    if (!checked.ok) {
      return checked;
    }
    return {
      ok: true,
      value: freezeValidatedData(sceneState(checked.value, checked.value.schemaVersion)),
    };
  }

  // The history's current snapshot must describe the same normalized data as the saved scene
  // Reject mismatches before restoring either stack so undo cannot introduce unrelated state
  const current = readObjects(rawCurrent, views?.current);
  const expected = readObjects(sceneState(project, version), views?.current);
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
    [rawPast, past, views?.past],
    [rawFuture, future, views?.future],
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
