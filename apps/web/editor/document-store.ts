import { validateTransform } from "../shared/project/spatial-validation";
import { freezeValidatedData, invalid } from "../shared/project/validation-helpers";
import { validateProject } from "../shared/project/project-validation";
import type {
  ContentObject,
  ContentProject,
  ProjectGroup,
} from "../shared/project/project-content";
import type { Transform } from "../shared/project/project-types";
import { prepareTransformCommand } from "./transform-command";
import { createCommandHistory, type EditCommand } from "./command-history";
import {
  captureRecoveryHistory,
  validateRecoveryHistory,
  isHierarchyState,
  type HistoryState,
} from "./recovery-history";
import type { CatalogueAsset } from "../shared/assets/catalogue.ts";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object.ts";
import { deserializeProject } from "../shared/project/project-deserialization";
import type { ProjectDocument } from "../shared/project/project-types";
import type { ValidationResult } from "../shared/project/validation-helpers";

function freezeProject(project: ProjectDocument): ProjectDocument {
  // Freeze the reader's separate copy before exposing it to panels or commands
  return freezeValidatedData(project);
}

export type TransformSession = Readonly<{
  token: string;
  objectId: string;
  before: Transform;
  after: Transform;
}>;

export function createDocumentStore(assets: readonly CatalogueAsset[]) {
  let objects: readonly SceneObject[] = Object.freeze([]);

  // The current grid-only editor has no environment-backed project at startup
  // Choosing a room creates the project; imports can supply one directly
  let project: ProjectDocument | null = null;
  let projectAssets: ReadonlyMap<string, string> = new Map();

  function snapRoom(position: Vector3Tuple): Vector3Tuple | null {
    // The approved test-room GLB spans -5 to 5 on floor axes and -0.2 to 3 in height
    // Keep this asset-specific until production rooms supply approved connection points
    const rooms = objects.filter((object) => object.assetId === "test-room-module-v1");
    const footprints = rooms.map(({ transform }) => {
      const [x, y, z, w] = transform.rotation;
      const [sx, sy, sz] = transform.scale;
      // Project the transformed room bounds onto the floor, including tilted rooms
      // Conservative bounds prevent a new room from cutting through existing geometry
      const xx = 1 - 2 * (y * y + z * z);
      const xy = 2 * (x * y - z * w);
      const xz = 2 * (x * z + y * w);
      const zx = 2 * (x * z - y * w);
      const zy = 2 * (y * z + x * w);
      const zz = 1 - 2 * (x * x + y * y);
      return {
        x: transform.position[0] + xy * 1.4 * sy,
        z: transform.position[2] + zy * 1.4 * sy,
        halfX: Math.abs(xx * sx * 5) + Math.abs(xy * sy * 1.6) + Math.abs(xz * sz * 5),
        halfZ: Math.abs(zx * sx * 5) + Math.abs(zy * sy * 1.6) + Math.abs(zz * sz * 5),
      };
    });
    // The initial environment has no object transform and always occupies the origin
    if (project?.scenes[0]?.environmentAssetId === "test-room-v1") {
      footprints.unshift({ x: 0, z: 0, halfX: 5, halfZ: 5 });
    }
    if (footprints.length === 0) {
      return position;
    }

    // Compare the four adjoining positions on every room, skipping occupied sides
    // Pointer proximity chooses the side; stable ordering resolves exact ties
    const candidates: Vector3Tuple[] = footprints.flatMap((room) => [
      [room.x + room.halfX + 5, 0, room.z],
      [room.x - room.halfX - 5, 0, room.z],
      [room.x, 0, room.z + room.halfZ + 5],
      [room.x, 0, room.z - room.halfZ - 5],
    ]);
    const available = candidates.filter(
      ([x, , z]) =>
        Math.abs(x) <= 10_000 &&
        Math.abs(z) <= 10_000 &&
        footprints.every(
          (room) =>
            Math.abs(x - room.x) >= room.halfX + 5 - 1e-8 ||
            Math.abs(z - room.z) >= room.halfZ + 5 - 1e-8,
        ),
    );
    available.sort(
      (a, b) =>
        Math.hypot(a[0] - position[0], a[2] - position[2]) -
        Math.hypot(b[0] - position[0], b[2] - position[2]),
    );
    return available[0] ?? null;
  }

  // Keep history here so the buttons and future edit controls share one undo order.
  const history = createCommandHistory<HistoryState>();

  // This clipboard belongs to the open editor, not the operating system.
  // Objects are immutable, so later edits won't change the captured copy.
  let clipboard: SceneObject | null = null;
  let pasteCount = 0;
  const listeners = new Set<() => void>();

  // Preview data stays outside the saved document and undo history.
  let edit: TransformSession | null = null;
  const editListeners = new Set<() => void>();
  function clearEdit() {
    if (edit === null) {
      return;
    }
    edit = null;
    editListeners.forEach((listener) => listener());
  }
  function notifyEdit() {
    editListeners.forEach((listener) => listener());
  }
  let snapshot: Readonly<{
    objects: readonly SceneObject[];
    project: ProjectDocument | null;
    canUndo: boolean;
    canRedo: boolean;
  }> = Object.freeze({ objects, project, canUndo: false, canRedo: false });

  function replaceObjects(nextObjects: readonly SceneObject[]) {
    objects = Object.freeze(nextObjects);
    const scene = project?.scenes[0];
    if (project !== null && scene !== undefined) {
      // Keep the editor's object list and saved document on the same array
      // Earlier snapshots retain their original scene and object order
      project =
        project.schemaVersion === 2
          ? Object.freeze({
              ...project,
              scenes: Object.freeze([
                Object.freeze({
                  ...project.scenes[0]!,
                  objects: objects as readonly ContentObject[],
                }),
                // The current editor edits the first scene while retaining every other scene unchanged
                ...project.scenes.slice(1),
              ]),
            })
          : Object.freeze({
              ...project,
              scenes: Object.freeze([Object.freeze({ ...scene, objects })]),
            });
    }
  }

  function historyState(): HistoryState {
    return project?.schemaVersion === 2
      ? { objects, groups: project.scenes[0]!.groups, sceneName: project.scenes[0]!.name }
      : objects;
  }

  function restoreState(state: HistoryState) {
    // Restore group membership before publishing so panels never see a half-restored tree
    if (isHierarchyState(state) && project?.schemaVersion === 2) {
      project = Object.freeze({
        ...project,
        scenes: Object.freeze([
          Object.freeze({
            ...project.scenes[0]!,
            groups: state.groups,
            name: state.sceneName ?? project.scenes[0]!.name,
          }),
          ...project.scenes.slice(1),
        ]),
      });
    }
    replaceObjects(isHierarchyState(state) ? state.objects : state);
  }

  function executeObjects(
    current: readonly SceneObject[],
    command: EditCommand<readonly SceneObject[]>,
  ) {
    // Existing placement, copying and transforms share the hierarchy's single undo order
    // Their commands change only objects and retain the surrounding group snapshot
    const before = historyState();
    const after = command.apply(current);
    if (after === current) return current;
    const next: HistoryState = isHierarchyState(before) ? { ...before, objects: after } : after;
    history.execute(before, { label: command.label, apply: () => next, revert: () => before });
    return after;
  }

  function checkContentObjects(next: readonly SceneObject[]): ValidationResult<true> {
    // Validate the proposed document before a command changes either objects or undo history
    if (project?.schemaVersion !== 2) {
      return { ok: true, value: true };
    }
    // Recheck the whole project because a local object edit can affect parents and rule targets
    const checked = validateProject(
      { ...project, scenes: [{ ...project.scenes[0], objects: next }, ...project.scenes.slice(1)] },
      projectAssets,
    );
    return checked.ok ? { ok: true, value: true } : checked;
  }

  function publish() {
    snapshot = Object.freeze({
      objects,
      project,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
    listeners.forEach((listener) => listener());
  }

  function commitTransform(
    input: unknown,
  ): ValidationResult<{ changed: boolean; object: SceneObject }> {
    // Include folders when tracing attachments so nested descendants move in the same undo step
    const groups = project?.schemaVersion === 2 ? project.scenes[0]!.groups : [];
    const result = prepareTransformCommand(objects, input, groups);
    if (!result.ok) {
      return result;
    }
    const { command, object } = result.value;
    if (command === null) {
      clearEdit();
      return { ok: true, value: { changed: false, object } };
    }
    // Try the proposed result before executing the command so rejection leaves Undo untouched
    const checked = checkContentObjects(command.apply(objects));
    if (!checked.ok) {
      return checked;
    }
    replaceObjects(executeObjects(objects, command));
    clearEdit();
    publish();
    return { ok: true, value: { changed: true, object } };
  }

  function insertCopy(source: SceneObject, offset: number): ValidationResult<SceneObject> {
    // Attached components need their own stable ID and reference remapping
    if (project?.schemaVersion === 2 && (source as ContentObject).components?.length) {
      return invalid("objectId", "This object's attached content cannot be copied safely");
    }
    const asset = assets.find((entry) => entry.id === source.assetId);
    if (
      !asset ||
      (project !== null && (asset.kind !== "model" || projectAssets.get(asset.id) !== "model"))
    ) {
      return invalid("assetId", "This asset is not available in this project");
    }
    if (objects.length >= 200) {
      return invalid("objects", "This scene has reached its 200-object limit");
    }
    // Validate the offset before allocating a new identity or changing the history cursor
    const [x, y, z] = source.transform.position;
    const checked = validateTransform(
      {
        ...source.transform,
        position: [x + offset, y, z + offset],
      },
      "transform",
    );
    if (!checked.ok) {
      return checked;
    }
    const transform = checked.value;
    Object.freeze(transform.position);
    Object.freeze(transform.rotation);
    Object.freeze(transform.scale);

    // Content-free copies retain their authored visibility and parent membership
    const object: SceneObject = Object.freeze({
      ...source,
      id: crypto.randomUUID(),
      name: source.name,
      assetId: source.assetId,
      transform: Object.freeze(transform),
      ...(project?.schemaVersion === 2
        ? {
            parentId: (source as ContentObject).parentId ?? null,
            visible: (source as ContentObject).visible ?? true,
            components: Object.freeze([]),
          }
        : {}),
    });
    // Confirm the copied parent and all remaining references still form a valid document
    const validCopy = checkContentObjects([...objects, object]);
    if (!validCopy.ok) {
      return validCopy;
    }
    replaceObjects(
      executeObjects(objects, {
        label: "Copy object",
        apply: (current) => Object.freeze([...current, object]),
        revert: (current) => Object.freeze(current.filter((entry) => entry.id !== object.id)),
      }),
    );
    clearEdit();
    publish();
    return { ok: true, value: object };
  }

  function editHierarchy(
    label: string,
    change: (scene: ContentProject["scenes"][number]) => ContentProject["scenes"][number],
  ): ValidationResult<true> {
    if (project === null) return invalid("project", "Choose a room first");

    // Grouping is the first operation that needs the v2 format in a released v1 project
    // Convert a candidate only; failed edits must leave the live document and history untouched
    const upgradeObjects = (items: readonly SceneObject[]) =>
      items.map((object) => ({
        ...object,
        parentId: null,
        visible: true,
        components: [],
      }));
    const content: ContentProject =
      project.schemaVersion === 2
        ? project
        : {
            ...project,
            schemaVersion: 2,
            scenes: project.scenes.map((scene) => ({
              ...scene,
              objects: upgradeObjects(scene.objects),
              groups: [],
              zones: [],
              viewpoints: [],
              rules: [],
            })),
          };
    const scene = content.scenes[0]!;
    const nextScene = change(scene);
    if (JSON.stringify(nextScene) === JSON.stringify(scene)) return { ok: true, value: true };
    const checked = validateProject(
      { ...content, scenes: [nextScene, ...content.scenes.slice(1)] },
      projectAssets,
    );
    if (!checked.ok) return checked;

    // Carry older placement/transform undo steps across the one-time format upgrade
    // Every retained state must pass the same v2 checks before any state is installed
    if (project.schemaVersion === 1) {
      const old = history.getStates();
      const converted = { past: [] as HistoryState[], future: [] as HistoryState[] };
      for (const stack of ["past", "future"] as const) {
        for (const state of old[stack]) {
          const items = isHierarchyState(state) ? state.objects : state;
          const candidate = { ...scene, objects: upgradeObjects(items) };
          const valid = validateProject({ ...content, scenes: [candidate] }, projectAssets);
          if (!valid.ok)
            return invalid("history", "An earlier edit cannot be retained in the grouped format");
          converted[stack].push(
            freezeValidatedData({ objects: candidate.objects, groups: [], sceneName: scene.name }),
          );
        }
      }
      project = freezeProject(content);
      objects = project.scenes[0]!.objects;
      history.restoreStates(historyState(), converted.past, converted.future);
    }

    // One immutable state includes the group records and every affected membership
    // Undoing an ungroup therefore restores both the folder and its original children
    const before = historyState();
    const validProject = checked.value as ContentProject;
    const next = freezeValidatedData({
      objects: validProject.scenes[0]!.objects,
      groups: validProject.scenes[0]!.groups,
      sceneName: validProject.scenes[0]!.name,
    });
    restoreState(history.execute(before, { label, apply: () => next, revert: () => before }));
    clearEdit();
    publish();
    return { ok: true, value: true };
  }

  return {
    addAttachedObject(assetId: string, parentId: string, position: Vector3Tuple) {
      // A placed case is identified by its object ID, never its asset name or list position
      // The caller supplies the model's display surface in world coordinates
      if (!objects.some((object) => object.id === parentId)) {
        return { ok: false, error: "This display case is no longer in the scene" } as const;
      }
      const asset = assets.find((entry) => entry.id === assetId && entry.kind === "model");
      if (!asset || projectAssets.get(assetId) !== "model") {
        return { ok: false, error: "Choose a model from this project's catalog" } as const;
      }
      const transform = validateTransform(
        { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        "transform",
      );
      if (!transform.ok) return { ok: false, error: transform.error.message } as const;
      // A case owns one displayed object; replacement keeps its identity and authored content
      // Reject ambiguous older layouts rather than silently deleting overlapping objects
      const displayed = objects.filter(
        (entry) => (entry as ContentObject).parentId?.toLowerCase() === parentId.toLowerCase(),
      );
      if (displayed.length > 1) {
        return {
          ok: false,
          error: "Remove extra attached objects before replacing this display",
        } as const;
      }
      const previous = displayed[0] as ContentObject | undefined;
      const object: ContentObject = {
        id: previous?.id ?? crypto.randomUUID(),
        name: asset.name,
        assetId,
        transform: previous?.transform ?? transform.value,
        parentId,
        visible: previous?.visible ?? true,
        components: previous?.components ?? [],
      };
      // Placement and attachment enter history together after full document validation
      // This also upgrades older projects without losing their earlier undo steps
      const result = editHierarchy(
        previous ? "Replace displayed asset" : "Place asset on display case",
        (scene) => ({
          ...scene,
          objects: previous
            ? scene.objects.map((entry) => (entry.id === previous.id ? object : entry))
            : [...scene.objects, object],
        }),
      );
      return result.ok
        ? ({ ok: true, object } as const)
        : ({ ok: false, error: result.error.message } as const);
    },
    removeDisplayedAsset(parentId: string) {
      if (!objects.some((object) => object.id === parentId)) {
        return invalid("parentId", "This display case is no longer in the scene");
      }
      const displayed = objects.filter(
        (entry) => (entry as ContentObject).parentId?.toLowerCase() === parentId.toLowerCase(),
      );
      if (displayed.length !== 1) {
        return invalid("parentId", "Choose a case containing exactly one displayed asset");
      }
      // Reuse deletion validation so dependent children or interaction references stay protected
      // The case remains in place and Undo restores the displayed object with its original ID
      return this.deleteObject(displayed[0]!.id);
    },
    createGroup(name: string, parentId: string | null = null): ValidationResult<ProjectGroup> {
      // The file format permits unfinished labels, but a newly named folder must be identifiable
      if (!name.trim()) return invalid("name", "Enter a group name");
      // Stable group IDs use the same namespace as objects and survive save, undo and redo
      const group: ProjectGroup = { id: crypto.randomUUID(), name: name.trim(), parentId };
      const result = editHierarchy("Create group", (scene) => ({
        ...scene,
        groups: [...scene.groups, group],
      }));
      return result.ok ? { ok: true, value: group } : result;
    },
    renameGroup(id: string, name: string): ValidationResult<true> {
      if (!name.trim()) return invalid("name", "Enter a group name");
      if (
        project?.schemaVersion !== 2 ||
        !project.scenes[0]!.groups.some((group) => group.id === id)
      ) {
        return invalid("groupId", "Choose a group in this scene");
      }
      return editHierarchy("Rename group", (scene) => ({
        ...scene,
        groups: scene.groups.map((group) =>
          group.id === id ? { ...group, name: name.trim() } : group,
        ),
      }));
    },
    ungroup(id: string): ValidationResult<true> {
      const group =
        project?.schemaVersion === 2
          ? project.scenes[0]!.groups.find((entry) => entry.id === id)
          : undefined;
      if (!group) return invalid("groupId", "Choose a group in this scene");

      // Removing a folder releases its direct children to its parent without deleting content
      // Deeper descendants keep their parents and all transforms stay in world coordinates
      return editHierarchy("Ungroup", (scene) => ({
        ...scene,
        groups: scene.groups
          .filter((entry) => entry.id !== id)
          .map((entry) =>
            entry.parentId?.toLowerCase() === id.toLowerCase()
              ? { ...entry, parentId: group.parentId }
              : entry,
          ),
        objects: scene.objects.map((object) =>
          object.parentId?.toLowerCase() === id.toLowerCase()
            ? { ...object, parentId: group.parentId }
            : object,
        ),
      }));
    },
    reparent(id: string, parentId: string | null): ValidationResult<true> {
      // Rooms are independent spaces; reject nesting at the command boundary for every caller
      if (
        parentId !== null &&
        objects.some((object) => object.id === id && object.assetId === "test-room-module-v1")
      ) {
        return invalid("parentId", "Rooms must remain at the scene root");
      }
      const groups = project?.schemaVersion === 2 ? project.scenes[0]!.groups : [];
      if (!objects.some((object) => object.id === id) && !groups.some((group) => group.id === id)) {
        return invalid("id", "Choose an object or group in this scene");
      }

      // The shared validator rejects missing parents, self-parenting and descendant cycles
      // Reparenting retains world transforms; later object movement carries its descendants
      return editHierarchy("Move in hierarchy", (scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === id ? { ...object, parentId } : object,
        ),
        groups: scene.groups.map((group) => (group.id === id ? { ...group, parentId } : group)),
      }));
    },
    renameObject(id: string, name: string): ValidationResult<true> {
      // The environment row uses the scene's existing name field, with the same undo order
      if (id === project?.scenes[0]?.id) {
        if (!name.trim()) return invalid("name", "Enter a room name");
        return editHierarchy("Rename room", (scene) => ({ ...scene, name: name.trim() }));
      }
      const object = objects.find((entry) => entry.id === id);
      if (!object) return invalid("objectId", "Choose an object in this scene");
      const trimmed = name.trim();
      if (!trimmed) return invalid("name", "Enter an object name");
      if (trimmed === object.name) return { ok: true, value: true };

      // Rename only this placed instance; retain its asset reference, identity and attachments
      const renamed = Object.freeze({ ...object, name: trimmed });
      const checked = checkContentObjects(
        objects.map((entry) => (entry.id === id ? renamed : entry)),
      );
      if (!checked.ok) return checked;
      replaceObjects(
        executeObjects(objects, {
          label: "Rename object",
          apply: (current) =>
            Object.freeze(current.map((entry) => (entry.id === id ? renamed : entry))),
          revert: (current) =>
            Object.freeze(current.map((entry) => (entry.id === id ? object : entry))),
        }),
      );
      clearEdit();
      publish();
      return { ok: true, value: true };
    },
    copyObject(objectId: string): ValidationResult<SceneObject> {
      const object = objects.find((entry) => entry.id === objectId);
      if (!object) {
        return invalid("objectId", "Select an object to copy");
      }
      clipboard = object;
      pasteCount = 0;
      return { ok: true, value: object };
    },
    pasteObject(): ValidationResult<SceneObject> {
      if (!clipboard) {
        return invalid("clipboard", "Copy an object first");
      }

      // Spread repeated pastes out rather than stacking them in the same spot.
      const result = insertCopy(clipboard, (pasteCount + 1) * 0.5);
      if (result.ok) {
        pasteCount++;
      }
      return result;
    },
    duplicateObject(objectId: string): ValidationResult<SceneObject> {
      const object = objects.find((entry) => entry.id === objectId);
      if (!object) {
        return invalid("objectId", "Select an object to duplicate");
      }
      return insertCopy(object, 0.5);
    },
    getTransformEdit: () => edit,
    subscribeTransformEdit(listener: () => void) {
      editListeners.add(listener);
      return () => {
        editListeners.delete(listener);
      };
    },
    beginTransform(objectId: string): ValidationResult<TransformSession> {
      const object = objects.find((item) => item.id === objectId);
      if (!object) {
        return invalid("objectId", "Choose an object in the scene");
      }

      // A fresh token prevents late events from an older drag changing this one.
      edit = Object.freeze({
        token: crypto.randomUUID(),
        objectId,
        before: object.transform,
        after: object.transform,
      });
      notifyEdit();
      return { ok: true, value: edit };
    },
    previewTransform(token: string, input: unknown): ValidationResult<TransformSession> {
      if (!edit || edit.token !== token) {
        return invalid("session", "This edit session has ended");
      }
      const result = validateTransform(input, "preview");

      // Cancel invalid previews rather than accidentally committing the last good position.
      if (!result.ok) {
        clearEdit();
        return result;
      }
      const after = result.value;
      Object.freeze(after.position);
      Object.freeze(after.rotation);
      Object.freeze(after.scale);
      Object.freeze(after);
      edit = Object.freeze({ ...edit, after });
      notifyEdit();
      return { ok: true, value: edit };
    },
    commitTransformEdit(
      token: string,
    ): ValidationResult<{ changed: boolean; object: SceneObject }> {
      if (!edit || edit.token !== token) {
        return invalid("session", "This edit session has ended");
      }
      const { objectId, before, after } = edit;
      const result = commitTransform({ objectId, before, after });
      clearEdit();
      return result;
    },
    cancelTransformEdit(token: string) {
      if (edit?.token === token) {
        clearEdit();
      }
    },
    getSnapshot: () => snapshot,
    resetProject() {
      // Return to the first-visit screen after the session has safely persisted New
      project = null;
      objects = Object.freeze([]);
      projectAssets = new Map();
      history.clear();
      clearEdit();
      clipboard = null;
      pasteCount = 0;
      publish();
    },
    getRecoveryHistory() {
      return project === null ? undefined : captureRecoveryHistory(project, history.getStates());
    },
    createProject(
      environmentAssetId: string,
      options: { startEmpty: boolean } = { startEmpty: false },
    ): ValidationResult<ProjectDocument> {
      // Room choice supplies the environment required by the saved format
      // Keep any models already placed on the grid and their undo commands
      if (project !== null && !options.startEmpty) {
        return { ok: false, error: { path: "project", message: "A project is already open" } };
      }
      const environment = assets.find((asset) => asset.id === environmentAssetId);
      if (environment?.kind !== "environment") {
        return {
          ok: false,
          error: { path: "environmentAssetId", message: "Choose a room from the library" },
        };
      }
      const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));

      // Fresh IDs keep this scene separate from earlier projects and their browser backups
      const candidate: ProjectDocument = {
        schemaVersion: 1,
        projectId: crypto.randomUUID(),
        title: "Untitled project",
        scenes: [
          {
            id: crypto.randomUUID(),
            name: environment.name,
            environmentAssetId,

            // Same elevated overview used by the sample project
            // Environments sit at the origin; the format has no movable room transform
            startCamera: {
              position: [12, 16, 18],
              rotation: [
                -0.29962059992658957, 0.2752183320355054, 0.09071781822041597, 0.9089844021041025,
              ],
              fovDegrees: 40,
            },
            objects: options.startEmpty ? [] : objects,
          },
        ],
      };

      // Run the import checks before replacing anything in memory
      // A bad asset reference leaves the grid scene and history available
      const checked = deserializeProject(JSON.stringify(candidate), kinds);
      if (!checked.ok) {
        return checked;
      }
      project = freezeProject(checked.value);
      objects = project.scenes[0]!.objects;
      projectAssets = kinds;

      // New starts a separate document; Undo must keep the previous project's objects out
      if (options.startEmpty) {
        history.clear();
        clearEdit();
        clipboard = null;
        pasteCount = 0;
      }
      publish();
      return { ok: true, value: project };
    },
    loadProject(
      text: unknown,
      assetKinds: ReadonlyMap<string, string>,
      recoveryHistory?: unknown,
    ): ValidationResult<ProjectDocument> {
      // Finish all checks before touching the open project or its undo history
      const result = deserializeProject(text, assetKinds);
      if (!result.ok) {
        return result;
      }
      const loaded = freezeProject(result.value);
      const scene = loaded.scenes[0];
      if (scene === undefined) {
        throw new Error("Validated M1 project needs one scene");
      }
      const loadedAssets = new Map(assetKinds);
      const recovered =
        recoveryHistory === undefined
          ? undefined
          : validateRecoveryHistory(recoveryHistory, loaded, loadedAssets);
      if (recovered !== undefined && !recovered.ok) {
        return recovered;
      }

      // Publish only after both the document and optional recovery history have passed
      project = loaded;
      clipboard = null;
      pasteCount = 0;
      objects = scene.objects;
      projectAssets = loadedAssets;

      // Undo from the previous project must never reintroduce its objects here
      history.clear();
      if (recovered?.ok) {
        history.restoreStates(historyState(), recovered.value.past, recovered.value.future);
      }
      clearEdit();
      publish();
      return { ok: true, value: loaded };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addObject(assetId: string, position: Vector3Tuple, parentId: string | null = null) {
      if (assetId === "test-room-module-v1" && parentId !== null) {
        return { ok: false, error: "Rooms must remain at the scene root" } as const;
      }

      const asset = assets.find((entry) => entry.id === assetId);
      if (asset === undefined) {
        return { ok: false, error: "Choose an asset from the library." } as const;
      }

      // Loaded projects keep environments in their dedicated scene field
      // Placed objects must remain valid model references when saved again
      if (project !== null && (asset.kind !== "model" || projectAssets.get(asset.id) !== "model")) {
        return { ok: false, error: "Choose a model from this project's catalog." } as const;
      }
      if (
        position.length !== 3 ||
        !position.every((value) => Number.isFinite(value) && Math.abs(value) <= 10_000)
      ) {
        return { ok: false, error: "Choose a position inside the scene." } as const;
      }
      if (objects.length >= 200) {
        return { ok: false, error: "This scene has reached its 200-object limit." } as const;
      }
      // Snap before creating the command so saved data, rendering and Redo share one position
      // Other assets keep their chosen coordinates and parent-selection behavior
      if (assetId === "test-room-module-v1" && project !== null) {
        const snapped = snapRoom(position);
        if (snapped === null) {
          return {
            ok: false,
            error: "No adjoining room position is available inside the scene",
          } as const;
        }
        position = snapped;
      }
      const object: SceneObject = Object.freeze({
        id: crypto.randomUUID(),
        name: `${asset.name} ${objects.length + 1}`,
        assetId: asset.id,
        transform: Object.freeze({
          position: Object.freeze([...position] as [number, number, number]),
          rotation: Object.freeze([0, 0, 0, 1] as const),
          scale: Object.freeze([1, 1, 1] as const),
        }),
        ...(project?.schemaVersion === 2
          ? { parentId: null, visible: true, components: Object.freeze([]) }
          : {}),
      });
      // Placement and membership enter history together so Undo never leaves a half-placed child
      // The first room is the scene environment; its children use the existing root representation
      if (parentId !== null && parentId !== project?.scenes[0]?.id) {
        const child = { ...object, parentId, visible: true, components: [] };
        const result = editHierarchy("Add object", (scene) => ({
          ...scene,
          objects: [...scene.objects, child],
        }));
        return result.ok
          ? ({ ok: true, object: child } as const)
          : ({ ok: false, error: result.error.message } as const);
      }
      // V2 defaults belong to the authored object so saving and undo retain the same shape
      const validPlacement = checkContentObjects([...objects, object]);
      if (!validPlacement.ok) {
        return { ok: false, error: validPlacement.error.message } as const;
      }

      // Capture this object once. Redo puts back this exact copy, including its ID.
      // Validation above finishes before the command can enter history.
      replaceObjects(
        executeObjects(objects, {
          label: "Add object",
          apply: (current) => Object.freeze([...current, object]),
          revert: (current) => Object.freeze(current.filter((entry) => entry.id !== object.id)),
        }),
      );
      clearEdit();
      publish();
      return { ok: true, object } as const;
    },
    commitTransform,

    // Keep the incoming gizmo API, but route it through the shared command history.
    setTransform(id: string, after: unknown) {
      const object = objects.find((entry) => entry.id === id);
      if (!object) {
        return { ok: false, error: "Select an object in this scene." } as const;
      }
      const result = commitTransform({ objectId: id, before: object.transform, after });
      if (!result.ok) {
        return { ok: false, error: `${result.error.path}: ${result.error.message}` } as const;
      }
      return { ok: true, changed: result.value.changed } as const;
    },
    deleteObject(objectId: string): ValidationResult<SceneObject> {
      const index = objects.findIndex((object) => object.id === objectId);
      const object = objects[index];
      if (!object) {
        return invalid("objectId", "This object is no longer in the scene");
      }

      // Reject dangling content, hierarchy and navigation references before touching history
      const validDeletion = checkContentObjects(objects.filter((entry) => entry.id !== objectId));
      if (!validDeletion.ok) {
        return validDeletion;
      }

      // Remember the slot as well as the whole object, so undo restores list order.
      replaceObjects(
        executeObjects(objects, {
          label: "Delete object",
          apply: (current) => Object.freeze(current.filter((entry) => entry.id !== objectId)),
          revert: (current) =>
            Object.freeze([...current.slice(0, index), object, ...current.slice(index)]),
        }),
      );
      clearEdit();
      publish();
      return { ok: true, value: object };
    },
    undo() {
      clearEdit();
      const before = historyState();
      const next = history.undo(before);

      // Nothing changed, so there is no new snapshot to send to the UI.
      if (next === before) {
        return;
      }
      restoreState(next);
      publish();
    },
    redo() {
      clearEdit();
      const before = historyState();
      const next = history.redo(before);
      if (next === before) {
        return;
      }
      restoreState(next);
      publish();
    },
  };
}
