import { validatePosition, validateTransform } from "../shared/project/spatial-validation";
import { freezeValidatedData, invalid } from "../shared/project/validation-helpers";
import { validateProject } from "../shared/project/project-validation";
import type { ContentObject, ProjectViewpoint } from "../shared/project/project-content";
import type { ProjectHotspot, ProjectScene, Transform } from "../shared/project/project-types";
import { prepareTransformCommand } from "./transform-command";
import { createCommandHistory, type EditCommand } from "./command-history";
import {
  captureProjectHistory,
  validateRecoveryHistory,
  type ProjectHistoryState,
} from "./recovery-history";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue.ts";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object.ts";
import { deserializeProject } from "../shared/project/project-deserialization";
import type { Interaction, ProjectDocument } from "../shared/project/project-types";
import type { ValidationResult } from "../shared/project/validation-helpers";

function freezeInteractions(interactions: readonly Interaction[]): readonly Interaction[] {
  return Object.freeze(
    interactions.map((interaction) =>
      Object.freeze({
        when: Object.freeze({ ...interaction.when }),
        do: Object.freeze({ ...interaction.do }),
      }),
    ),
  );
}

function freezeHotspots(hotspots: readonly ProjectHotspot[]): readonly ProjectHotspot[] {
  return Object.freeze(
    hotspots.map((hotspot) =>
      Object.freeze({
        ...hotspot,
        position: Object.freeze([...hotspot.position]) as ProjectHotspot["position"],
      }),
    ),
  );
}

function createProjectId(): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const random = crypto.randomUUID();
  // RFC 9562 v7 keeps the native UUID's variant and 74 random suffix bits
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15)}`;
}

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

  // Keep history here so the buttons and future edit controls share one undo order.
  type State = Readonly<{ objects: readonly SceneObject[] }> &
    (ProjectHistoryState | Readonly<{ project: null; activeSceneId: null }>);
  type SceneEdit = Pick<ProjectScene, "objects" | "hotspots" | "interactions">;
  let state: State = Object.freeze({ objects, project: null, activeSceneId: null });
  const history = createCommandHistory<State>();

  function fromProject(document: ProjectDocument, active: string): State {
    const scene = document.scenes.find((s) => s.id === active);
    if (!scene) throw new Error("History refers to a missing active scene");
    return Object.freeze({ project: document, activeSceneId: scene.id, objects: scene.objects });
  }
  function activeScene() {
    return project?.scenes.find((scene) => scene.id === state.activeSceneId);
  }
  function sceneState(): SceneEdit {
    const scene = activeScene();
    return { objects, hotspots: scene?.hotspots ?? [], interactions: scene?.interactions ?? [] };
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
    activeSceneId: string | null;
    canUndo: boolean;
    canRedo: boolean;
  }> = Object.freeze({ objects, project, activeSceneId: null, canUndo: false, canRedo: false });

  function replaceState(next: State) {
    state = next;
    objects = next.objects;
    project = next.project;
  }

  function executeState(after: State, label: string) {
    const before = state;
    replaceState(history.execute(before, { label, apply: () => after, revert: () => before }));
  }

  function executeScene(label: string, next: SceneEdit) {
    if (state.project === null) {
      executeState(Object.freeze({ ...state, objects: next.objects }), label);
      return;
    }
    // Capture the whole document, preserving untouched scenes and their object identity.
    const document = Object.freeze({
      ...state.project,
      scenes: Object.freeze(
        state.project.scenes.map((scene) =>
          scene.id === state.activeSceneId ? Object.freeze({ ...scene, ...next }) : scene,
        ),
      ),
    }) as ProjectDocument;
    executeState(fromProject(document, state.activeSceneId), label);
  }

  function executeObjects(command: EditCommand<readonly SceneObject[]>) {
    const next = command.apply(objects);
    if (next !== objects) executeScene(command.label, { ...sceneState(), objects: next });
  }

  function checkContentObjects(next: readonly SceneObject[]): ValidationResult<true> {
    return checkScene({ ...sceneState(), objects: next });
  }

  function checkScene(next: SceneEdit): ValidationResult<true> {
    // Validate all affected lists together before changing the document or history.
    if (project === null) {
      return { ok: true, value: true };
    }
    // Recheck the whole project because a local object edit can affect parents and rule targets
    const checked = validateProject(
      {
        ...project,
        scenes: project.scenes.map((scene) =>
          scene.id === state.activeSceneId ? { ...scene, ...next } : scene,
        ),
      },
      projectAssets,
      { allowDraftLinks: true },
    );
    return checked.ok ? { ok: true, value: true } : checked;
  }

  function publish() {
    snapshot = Object.freeze({
      objects,
      project,
      activeSceneId: state.activeSceneId,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
    listeners.forEach((listener) => listener());
  }

  function commitTransform(
    input: unknown,
  ): ValidationResult<{ changed: boolean; object: SceneObject }> {
    const result = prepareTransformCommand(objects, input);
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
    executeObjects(command);
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
    executeObjects({
      label: "Copy object",
      apply: (current) => Object.freeze([...current, object]),
      revert: (current) => Object.freeze(current.filter((entry) => entry.id !== object.id)),
    });
    clearEdit();
    publish();
    return { ok: true, value: object };
  }

  return {
    switchScene(id: string): ValidationResult<true> {
      if (!project?.scenes.some((scene) => scene.id === id))
        return invalid("scene", "This scene no longer exists");
      if (id === state.activeSceneId) return { ok: true, value: true };
      clearEdit();
      replaceState(fromProject(project, id));
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
      state = Object.freeze({ objects, project: null, activeSceneId: null });
      projectAssets = new Map();
      history.clear();
      clearEdit();
      clipboard = null;
      pasteCount = 0;
      publish();
    },
    getRecoveryHistory() {
      if (state.project === null) return undefined;
      const states = history.getStates();
      const saved = (entry: State): ProjectHistoryState => {
        // createProject upgrades the grid-only history before it can be persisted.
        if (entry.project === null) throw new Error("Project history contains a grid-only edit");
        return { project: entry.project, activeSceneId: entry.activeSceneId };
      };
      return captureProjectHistory(state.project, state.activeSceneId, {
        past: states.past.map(saved),
        future: states.future.map(saved),
      });
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
        projectId: createProjectId(),
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
            hotspots: [],
            interactions: [],
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
      state = fromProject(project, project.scenes[0]!.id);
      projectAssets = kinds;

      // Choosing the first room promotes all grid edits, including redo, into this document.
      // Undo must not bring back a null project or borrow attachments from a later edit.
      if (!options.startEmpty) {
        const old = history.getStates();
        const created = project;
        const upgrade = (entry: State) =>
          fromProject(
            freezeProject({
              ...created,
              scenes: [{ ...created.scenes[0]!, objects: entry.objects }],
            } as ProjectDocument),
            created.scenes[0]!.id,
          );
        history.restoreStates(state, old.past.map(upgrade), old.future.map(upgrade));
      }

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
      replaceState(
        fromProject(
          loaded,
          recovered?.ok ? (recovered.value.documents?.activeSceneId ?? scene.id) : scene.id,
        ),
      );
      projectAssets = loadedAssets;

      // Undo from the previous project must never reintroduce its objects here
      history.clear();
      if (recovered?.ok) {
        const documents = recovered.value.documents;
        if (documents) {
          const restore = (entry: ProjectHistoryState) =>
            fromProject(freezeProject(entry.project), entry.activeSceneId);
          history.restoreStates(state, documents.past.map(restore), documents.future.map(restore));
        } else {
          // Older history edits the first scene; retain every other scene and its references.
          const legacy = (
            objects: readonly SceneObject[],
            viewpoints?: readonly ProjectViewpoint[],
          ) =>
            fromProject(
              freezeProject({
                ...loaded,
                scenes: [
                  { ...scene, objects, ...(viewpoints ? { viewpoints } : {}) },
                  ...loaded.scenes.slice(1),
                ],
              } as ProjectDocument),
              scene.id,
            );
          history.restoreStates(
            state,
            recovered.value.past.map((objects, i) =>
              legacy(objects, recovered.value.views?.past[i]),
            ),
            recovered.value.future.map((objects, i) =>
              legacy(objects, recovered.value.views?.future[i]),
            ),
          );
        }
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
        ...(project?.schemaVersion === 2
          ? { parentId: null, visible: true, components: Object.freeze([]) }
          : {}),
      });
      // V2 defaults belong to the authored object so saving and undo retain the same shape
      const validPlacement = checkContentObjects([...objects, object]);
      if (!validPlacement.ok) {
        return { ok: false, error: validPlacement.error.message } as const;
      }

      // Capture this object once. Redo puts back this exact copy, including its ID.
      // Validation above finishes before the command can enter history.
      executeObjects({
        label: "Add object",
        apply: (current) => Object.freeze([...current, object]),
        revert: (current) => Object.freeze(current.filter((entry) => entry.id !== object.id)),
      });
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
    addHotspot(objectId: string, position: Vector3Tuple = [0, 0, 0]) {
      const scene = activeScene();
      if (project === null || scene === undefined) {
        return invalid("project", "Choose a room before adding hotspots");
      }
      const objectKey = objectId.toLowerCase();
      const target = objects.find((object) => object.id.toLowerCase() === objectKey);
      if (target === undefined) {
        return invalid("objectId", "Select an object to attach the hotspot to");
      }
      if (scene.hotspots.some((hotspot) => hotspot.objectId.toLowerCase() === objectKey)) {
        return invalid("objectId", "Each object can have at most one hotspot");
      }
      if (
        project.schemaVersion === 2 &&
        (target as ContentObject).components.some((component) => component.type === "hotspot")
      ) {
        return invalid("objectId", "Each object can have at most one hotspot");
      }
      if (scene.hotspots.length >= 200) {
        return invalid("hotspots", "This scene has reached its 200-hotspot limit");
      }
      const checked = validatePosition(position, "position");
      if (!checked.ok) return checked;
      const hotspot = Object.freeze({
        id: crypto.randomUUID(),
        objectId: target.id,
        position: Object.freeze([...checked.value]) as ProjectHotspot["position"],
      });
      const next = { ...sceneState(), hotspots: Object.freeze([...scene.hotspots, hotspot]) };
      const valid = checkScene(next);
      if (!valid.ok) return valid;
      executeScene("Add hotspot", next);
      clearEdit();
      publish();
      return { ok: true, value: hotspot } as const;
    },
    deleteHotspot(hotspotId: string) {
      const scene = activeScene();
      if (project === null || scene === undefined) {
        return invalid("project", "No project is open");
      }
      if (!scene.hotspots.some((hotspot) => hotspot.id.toLowerCase() === hotspotId.toLowerCase())) {
        return invalid("hotspotId", "This hotspot is no longer in the scene");
      }
      const next = {
        ...sceneState(),
        hotspots: freezeHotspots(
          scene.hotspots.filter((hotspot) => hotspot.id.toLowerCase() !== hotspotId.toLowerCase()),
        ),
        interactions: freezeInteractions(
          scene.interactions.filter(
            (interaction) =>
              interaction.when.type !== "visitor-clicks-hotspot" ||
              interaction.when.targetHotspotId.toLowerCase() !== hotspotId.toLowerCase(),
          ),
        ),
      };
      const valid = checkScene(next);
      if (!valid.ok) return valid;
      executeScene("Delete hotspot", next);
      clearEdit();
      publish();
      return { ok: true, value: true } as const;
    },
    setInteractions(nextInteractions: readonly Interaction[]) {
      const scene = activeScene();
      if (project === null || scene === undefined) {
        return invalid("project", "Place an object or open a project before adding interactions");
      }
      const hotspotIds = new Set(scene.hotspots.map((hotspot) => hotspot.id.toLowerCase()));
      for (const interaction of nextInteractions) {
        if (
          interaction.when.type === "visitor-clicks-hotspot" &&
          !hotspotIds.has(interaction.when.targetHotspotId.toLowerCase())
        ) {
          return invalid("when.targetHotspotId", "Choose a hotspot in this scene");
        }
      }
      const interactions = freezeInteractions(nextInteractions);
      const next = { ...sceneState(), interactions };
      const valid = checkScene(next);
      if (!valid.ok) return valid;
      if (JSON.stringify(interactions) === JSON.stringify(scene.interactions)) {
        return { ok: true, value: scene.interactions } as const;
      }
      executeScene("Edit interactions", next);
      clearEdit();
      publish();
      return { ok: true, value: interactions } as const;
    },
    deleteObject(objectId: string): ValidationResult<SceneObject> {
      const index = objects.findIndex(
        (object) => object.id.toLowerCase() === objectId.toLowerCase(),
      );
      const object = objects[index];
      if (!object) {
        return invalid("objectId", "This object is no longer in the scene");
      }

      // Remove attachments before validation so deletion is valid for both project versions.
      const current = sceneState();
      const removed = new Set(
        current.hotspots
          .filter((hotspot) => hotspot.objectId.toLowerCase() === object.id.toLowerCase())
          .map((hotspot) => hotspot.id.toLowerCase()),
      );
      const next: SceneEdit = {
        objects: Object.freeze(objects.filter((entry) => entry !== object)),
        hotspots: Object.freeze(
          current.hotspots.filter((hotspot) => !removed.has(hotspot.id.toLowerCase())),
        ),
        interactions: Object.freeze(
          current.interactions.filter(
            (interaction) =>
              interaction.when.type !== "visitor-clicks-hotspot" ||
              !removed.has(interaction.when.targetHotspotId.toLowerCase()),
          ),
        ),
      };
      // Other content, hierarchy and navigation references still must remain valid.
      const validDeletion = checkScene(next);
      if (!validDeletion.ok) {
        return validDeletion;
      }

      // One snapshot restores all three lists, including their IDs and original order.
      executeScene("Delete object", next);
      clearEdit();
      publish();
      return { ok: true, value: object };
    },
    undo() {
      clearEdit();
      const next = history.undo(state);

      // Nothing changed, so there is no new snapshot to send to the UI.
      if (next === state) {
        return;
      }
      replaceState(next);
      publish();
    },
    redo() {
      clearEdit();
      const next = history.redo(state);
      if (next === state) {
        return;
      }
      replaceState(next);
      publish();
    },
  };
}
