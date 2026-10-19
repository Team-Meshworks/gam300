import { validateCameraPose, validateTransform } from "../shared/project/spatial-validation";
import { invalid } from "../shared/project/validation-helpers";
import type { Transform, NamedViewpoint, CameraPose } from "../shared/project/project-types";
import { prepareTransformCommand } from "./transform-command";
import { createCommandHistory, type EditCommand } from "./command-history";
import { captureRecoveryHistory, validateRecoveryHistory } from "./recovery-history";
import type { CatalogueAsset } from "../shared/assets/catalogue.ts";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object.ts";
import { deserializeProject } from "../shared/project/project-deserialization";
import type { ProjectDocument } from "../shared/project/project-types";
import type { ValidationResult } from "../shared/project/validation-helpers";

function freezeProject(project: ProjectDocument): ProjectDocument {
  // Freeze the reader's separate copy before exposing it to panels or commands
  for (const scene of project.scenes) {
    for (const object of scene.objects) {
      Object.freeze(object.transform.position);
      Object.freeze(object.transform.rotation);
      Object.freeze(object.transform.scale);
      Object.freeze(object.transform);
      Object.freeze(object);
    }
    for (const view of scene.viewpoints ?? []) {
      Object.freeze(view.camera.position);
      Object.freeze(view.camera.rotation);
      Object.freeze(view.camera);
      Object.freeze(view);
    }
    if (scene.viewpoints) Object.freeze(scene.viewpoints);
    Object.freeze(scene.objects);
    Object.freeze(scene.startCamera.position);
    Object.freeze(scene.startCamera.rotation);
    Object.freeze(scene.startCamera);
    Object.freeze(scene);
  }
  Object.freeze(project.scenes);
  return Object.freeze(project);
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
  // Keep history here so the buttons and future edit controls share one undo order.
  type State = {
    objects: readonly SceneObject[];
    viewpoints?: readonly NamedViewpoint[] | undefined;
  };
  let state: State = { objects };
  const history = createCommandHistory<State>();
  function executeObjects(
    _objects: readonly SceneObject[],
    command: EditCommand<readonly SceneObject[]>,
  ) {
    state = history.execute(state, {
      label: command.label,
      apply: (current) => {
        const next = command.apply(current.objects);
        return next === current.objects ? current : { ...current, objects: next };
      },
      revert: (current) => ({ ...current, objects: command.revert(current.objects) }),
    });
    return state.objects;
  }
  // This clipboard belongs to the open editor, not the operating system.
  // Objects are immutable, so later edits won't change the captured copy.
  let clipboard: SceneObject | null = null;
  let pasteCount = 0;
  const listeners = new Set<() => void>();
  // Preview data stays outside the saved document and undo history.
  let edit: TransformSession | null = null;
  const editListeners = new Set<() => void>();
  function clearEdit() {
    if (edit === null) return;
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
    state = { ...state, objects };
    const scene = project?.scenes[0];
    if (project !== null && scene !== undefined) {
      // Keep the editor's object list and saved document on the same array
      // Earlier snapshots retain their original scene and object order
      const nextScene = { ...scene, objects };
      if (state.viewpoints === undefined) delete nextScene.viewpoints;
      else nextScene.viewpoints = state.viewpoints;
      project = Object.freeze({ ...project, scenes: Object.freeze([Object.freeze(nextScene)]) });
    }
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
    const result = prepareTransformCommand(objects, input);
    if (!result.ok) return result;
    const { command, object } = result.value;
    if (command === null) {
      clearEdit();
      return { ok: true, value: { changed: false, object } };
    }
    replaceObjects(executeObjects(objects, command));
    clearEdit();
    publish();
    return { ok: true, value: { changed: true, object } };
  }

  function insertCopy(source: SceneObject, offset: number): ValidationResult<SceneObject> {
    const asset = assets.find((entry) => entry.id === source.assetId);
    if (
      !asset ||
      (project !== null && (asset.kind !== "model" || projectAssets.get(asset.id) !== "model"))
    )
      return invalid("assetId", "This asset is not available in this project");
    if (objects.length >= 200)
      return invalid("objects", "This scene has reached its 200-object limit");
    const [x, y, z] = source.transform.position;
    const checked = validateTransform(
      {
        ...source.transform,
        position: [x + offset, y, z + offset],
      },
      "transform",
    );
    if (!checked.ok) return checked;
    const transform = checked.value;
    Object.freeze(transform.position);
    Object.freeze(transform.rotation);
    Object.freeze(transform.scale);
    // Copy only today's object fields; attached content will need its own ID remapping later.
    const object: SceneObject = Object.freeze({
      id: crypto.randomUUID(),
      name: source.name,
      assetId: source.assetId,
      transform: Object.freeze(transform),
    });
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

  function editViews(next: readonly NamedViewpoint[]): ValidationResult<true> {
    if (!project) return invalid("project", "Choose a room first");
    const checked = deserializeProject(
      JSON.stringify({ ...project, scenes: [{ ...project.scenes[0], viewpoints: next }] }),
      projectAssets,
    );
    if (!checked.ok) return checked;
    const views = freezeProject(checked.value).scenes[0]!.viewpoints!;
    if (JSON.stringify(state.viewpoints ?? []) === JSON.stringify(views))
      return { ok: true, value: true };
    const before = state;
    const after = { ...state, viewpoints: views };
    state = history.execute(state, {
      label: "Edit viewpoints",
      apply: () => after,
      revert: () => before,
    });
    // Undoing the first view leaves an empty list, not the last saved view.
    replaceObjects(state.objects);
    clearEdit();
    publish();
    return { ok: true, value: true };
  }

  return {
    addViewpoint(name: string, camera: CameraPose): ValidationResult<true> {
      const checked = validateCameraPose(camera, "camera");
      if (!checked.ok) return checked;
      return editViews([
        ...(state.viewpoints ?? []),
        { id: crypto.randomUUID(), name: name.trim(), camera: checked.value },
      ]);
    },
    renameViewpoint(id: string, name: string): ValidationResult<true> {
      if (!state.viewpoints?.some((v) => v.id === id))
        return invalid("viewpoint", "This viewpoint no longer exists");
      return editViews(
        state.viewpoints.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)),
      );
    },
    moveViewpoint(id: string, targetIndex: number): ValidationResult<true> {
      const current = state.viewpoints ?? [];
      const from = current.findIndex((v) => v.id === id);
      if (from < 0) return invalid("viewpoint", "This viewpoint no longer exists");
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= current.length)
        return invalid("viewpoint", "Choose a position within the saved views");
      if (from === targetIndex) return { ok: true, value: true };
      const next = [...current];
      const [view] = next.splice(from, 1);
      next.splice(targetIndex, 0, view!);
      // Commit only the final order. Hovering or cancelling a drag never enters history.
      return editViews(next);
    },
    deleteViewpoint(id: string): ValidationResult<true> {
      if (!state.viewpoints?.some((v) => v.id === id))
        return invalid("viewpoint", "This viewpoint no longer exists");
      return editViews(state.viewpoints.filter((v) => v.id !== id));
    },
    copyObject(objectId: string): ValidationResult<SceneObject> {
      const object = objects.find((entry) => entry.id === objectId);
      if (!object) return invalid("objectId", "Select an object to copy");
      clipboard = object;
      pasteCount = 0;
      return { ok: true, value: object };
    },
    pasteObject(): ValidationResult<SceneObject> {
      if (!clipboard) return invalid("clipboard", "Copy an object first");
      // Spread repeated pastes out rather than stacking them in the same spot.
      const result = insertCopy(clipboard, (pasteCount + 1) * 0.5);
      if (result.ok) pasteCount++;
      return result;
    },
    duplicateObject(objectId: string): ValidationResult<SceneObject> {
      const object = objects.find((entry) => entry.id === objectId);
      if (!object) return invalid("objectId", "Select an object to duplicate");
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
      if (!object) return invalid("objectId", "Choose an object in the scene");
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
      if (!edit || edit.token !== token) return invalid("session", "This edit session has ended");
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
      if (!edit || edit.token !== token) return invalid("session", "This edit session has ended");
      const { objectId, before, after } = edit;
      const result = commitTransform({ objectId, before, after });
      clearEdit();
      return result;
    },
    cancelTransformEdit(token: string) {
      if (edit?.token === token) clearEdit();
    },
    getSnapshot: () => snapshot,
    getRecoveryHistory() {
      if (project === null) return undefined;
      const states = history.getStates();
      return captureRecoveryHistory(
        project,
        {
          past: states.past.map((s) => s.objects),
          future: states.future.map((s) => s.objects),
        },
        {
          past: states.past.map((s) => s.viewpoints ?? []),
          future: states.future.map((s) => s.viewpoints ?? []),
        },
      );
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
      if (!checked.ok) return checked;
      project = freezeProject(checked.value);
      objects = project.scenes[0]!.objects;
      state = { objects, viewpoints: project.scenes[0]!.viewpoints };
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
      if (!result.ok) return result;
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
      if (recovered !== undefined && !recovered.ok) return recovered;

      project = loaded;
      clipboard = null;
      pasteCount = 0;
      objects = scene.objects;
      state = { objects, viewpoints: scene.viewpoints };
      projectAssets = loadedAssets;
      // Undo from the previous project must never reintroduce its objects here
      history.clear();
      if (recovered?.ok)
        history.restoreStates(
          state,
          recovered.value.past.map((objects, i) => ({
            objects,
            viewpoints: recovered.value.views?.past[i] ?? scene.viewpoints,
          })),
          recovered.value.future.map((objects, i) => ({
            objects,
            viewpoints: recovered.value.views?.future[i] ?? scene.viewpoints,
          })),
        );
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
    addObject(assetId: string, position: Vector3Tuple) {
      const asset = assets.find((entry) => entry.id === assetId);
      if (asset === undefined) {
        return { ok: false, error: "Choose an asset from the library." } as const;
      }
      // Loaded projects keep environments in their dedicated scene field
      // Placed objects must remain valid model references when saved again
      if (project !== null && (asset.kind !== "model" || projectAssets.get(asset.id) !== "model")) {
        return { ok: false, error: "Choose a model from this project's catalog." } as const;
      }
      if (!position.every((value) => Number.isFinite(value) && Math.abs(value) <= 10_000)) {
        return { ok: false, error: "Choose a position inside the scene." } as const;
      }
      if (objects.length >= 200) {
        return { ok: false, error: "This scene has reached its 200-object limit." } as const;
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
      });
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
      if (!object) return { ok: false, error: "Select an object in this scene." } as const;
      const result = commitTransform({ objectId: id, before: object.transform, after });
      if (!result.ok)
        return { ok: false, error: `${result.error.path}: ${result.error.message}` } as const;
      return { ok: true, changed: result.value.changed } as const;
    },
    deleteObject(objectId: string): ValidationResult<SceneObject> {
      const index = objects.findIndex((object) => object.id === objectId);
      const object = objects[index];
      if (!object) return invalid("objectId", "This object is no longer in the scene");
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
      const next = history.undo(state);
      // Nothing changed, so there is no new snapshot to send to the UI.
      if (next === state) return;
      state = next;
      replaceObjects(next.objects);
      publish();
    },
    redo() {
      clearEdit();
      const next = history.redo(state);
      if (next === state) return;
      state = next;
      replaceObjects(next.objects);
      publish();
    },
  };
}
