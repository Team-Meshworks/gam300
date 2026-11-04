import {
  validateCameraPose,
  validatePosition,
  validateTransform,
} from "../shared/project/spatial-validation";
import { freezeValidatedData, invalid } from "../shared/project/validation-helpers";
import { validateProject } from "../shared/project/project-validation";
import type {
  ContentComponent,
  ContentObject,
  ContentProject,
  ContentScene,
  ProjectGroup,
} from "../shared/project/project-content";
import type {
  ProjectHotspot,
  ProjectScene,
  Transform,
  NamedViewpoint,
  CameraPose,
} from "../shared/project/project-types";
import { prepareTransformCommand } from "./transform-command";
import { createCommandHistory, type EditCommand } from "./command-history";
import {
  captureProjectHistory,
  validateRecoveryHistory,
  type ProjectHistoryState,
  isHierarchyState,
  type HistoryState,
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

function toContentProject(project: ProjectDocument): ContentProject {
  if (project.schemaVersion === 2) return project;
  return {
    ...project,
    schemaVersion: 2,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      groups: [],
      zones: [],
      viewpoints: [],
      rules: [],
      objects: scene.objects.map((object) => ({
        ...object,
        parentId: null,
        visible: true,
        components: [],
      })),
    })),
  };
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
    if (activeScene()?.environmentAssetId === "test-room-v1") {
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
  let loadGeneration = 0;
  let snapshot: Readonly<{
    loadGeneration: number;
    objects: readonly SceneObject[];
    project: ProjectDocument | null;
    activeSceneId: string | null;
    canUndo: boolean;
    canRedo: boolean;
  }> = Object.freeze({
    loadGeneration,
    objects,
    project,
    activeSceneId: null,
    canUndo: false,
    canRedo: false,
  });

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
      loadGeneration,
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
    // Carry descendants in the active scene through the same immutable transform command
    const groups = project?.schemaVersion === 2 ? activeGroups() : [];
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
    executeObjects(command);
    clearEdit();
    publish();
    return { ok: true, value: { changed: true, object } };
  }

  function insertCopy(source: SceneObject, offset: number): ValidationResult<SceneObject> {
    // Attached components need their own stable ID and reference remapping
    if ((source as ContentObject).components?.length) {
      return invalid("objectId", "This object's attached content cannot be copied safely");
    }
    if (
      project?.schemaVersion !== 2 &&
      ((source as ContentObject).parentId != null || (source as ContentObject).visible === false)
    ) {
      return invalid("objectId", "This object's hierarchy or visibility requires a v2 project");
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

  function activeGroups() {
    return project?.schemaVersion === 2
      ? (project.scenes.find((scene) => scene.id === state.activeSceneId)?.groups ?? [])
      : [];
  }

  function editHierarchy(
    label: string,
    change: (scene: ContentScene) => ContentScene,
  ): ValidationResult<true> {
    if (!project || !state.activeSceneId) return invalid("project", "Choose a room first");
    const content = toContentProject(project);
    const scene = content.scenes.find((entry) => entry.id === state.activeSceneId)!;
    const nextScene = change(scene);
    if (JSON.stringify(nextScene) === JSON.stringify(scene)) return { ok: true, value: true };

    // Validate the whole candidate before upgrading any retained undo states or publishing the edit
    const checked = validateProject(
      {
        ...content,
        scenes: content.scenes.map((entry) => (entry.id === scene.id ? nextScene : entry)),
      },
      projectAssets,
      { allowDraftLinks: true },
    );
    if (!checked.ok) return checked;

    // Keep earlier placement steps compatible when hierarchy editing first upgrades a released project
    if (project.schemaVersion === 1) {
      const previous = history.getStates();
      const upgrade = (entry: State): State =>
        fromProject(
          freezeProject(toContentProject(entry.project ?? project!)),
          entry.activeSceneId ?? scene.id,
        );
      replaceState(upgrade(state));
      history.restoreStates(state, previous.past.map(upgrade), previous.future.map(upgrade));
    }
    return commitProject(checked.value, scene.id, label);
  }

  function editViews(next: readonly NamedViewpoint[]): ValidationResult<true> {
    if (!project) return invalid("project", "Create a scene first");
    const scene = project.scenes.find((s) => s.id === state.activeSceneId)!;
    const content = toContentProject(project);
    const updated = { ...content.scenes.find((s) => s.id === scene.id)!, viewpoints: next };
    // The first capture supplies an initial camera; later ordering never changes it.
    if (!scene.viewpoints?.length && next.length) updated.startCamera = next[0]!.camera;
    return commitProject(
      { ...content, scenes: content.scenes.map((s) => (s.id === scene.id ? updated : s)) },
      scene.id,
      "Edit viewpoints",
    );
  }

  function commitProject(next: unknown, active: string, label: string): ValidationResult<true> {
    const checked = validateProject(next, projectAssets, { allowDraftLinks: true });
    if (!checked.ok) return checked;
    if (JSON.stringify(project) === JSON.stringify(checked.value)) return { ok: true, value: true };
    // Keep unchanged scene references so renaming/reordering does not reset the live camera.
    const frozen = freezeProject(checked.value);
    const shared = Object.freeze({
      ...frozen,
      scenes: Object.freeze(
        frozen.scenes.map((scene) => {
          const old = project?.scenes.find((s) => s.id === scene.id);
          if (!old) return scene;
          if (JSON.stringify(old) === JSON.stringify(scene)) return old;
          // Retain unchanged authored collections as well as the camera when a different field changes
          return Object.freeze(
            Object.fromEntries(
              Object.entries(scene).map(([key, value]) => {
                const previous = old[key as keyof typeof old];
                return [key, JSON.stringify(previous) === JSON.stringify(value) ? previous : value];
              }),
            ),
          ) as ProjectScene;
        }),
      ),
    });
    executeState(fromProject(shared as ProjectDocument, active), label);
    clearEdit();
    publish();
    return { ok: true, value: true };
  }

  return {
    setDisplayContent(objectId: string, component: ContentComponent | null) {
      if (project === null) return invalid("project", "Choose a room first");
      const target = objects.find((object) => object.id === objectId);
      if (!target) return invalid("objectId", "Choose a display in the current scene");
      const asset = assets.find((entry) => entry.id === target.assetId);
      if (asset?.displayRole !== "digital") {
        return invalid("objectId", "Choose a digital stand or panel");
      }
      if (component && !["text", "image", "video"].includes(component.type)) {
        return invalid("component", "Choose text, an image or a video");
      }
      const content = toContentProject(project);
      const next = {
        ...content,
        scenes: content.scenes.map((scene) =>
          scene.id !== state.activeSceneId
            ? scene
            : {
                ...scene,
                objects: scene.objects.map((object) =>
                  object.id !== target.id
                    ? object
                    : {
                        ...object,
                        components: [
                          ...object.components.filter(
                            (entry) => !["text", "image", "video"].includes(entry.type),
                          ),
                          ...(component ? [component] : []),
                        ],
                      },
                ),
              },
        ),
      };
      return commitProject(
        next,
        state.activeSceneId!,
        component ? "Edit display content" : "Remove display content",
      );
    },
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
      if (project?.schemaVersion !== 2 || !activeGroups().some((group) => group.id === id)) {
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
        project?.schemaVersion === 2 ? activeGroups().find((entry) => entry.id === id) : undefined;
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
      const groups = project?.schemaVersion === 2 ? activeGroups() : [];
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
      if (id === activeScene()?.id) {
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
      executeObjects({
        label: "Rename object",
        apply: (current) =>
          Object.freeze(current.map((entry) => (entry.id === id ? renamed : entry))),
        revert: (current) =>
          Object.freeze(current.map((entry) => (entry.id === id ? object : entry))),
      });
      clearEdit();
      publish();
      return { ok: true, value: true };
    },
    createScene(
      name: string,
      environmentAssetId = project?.scenes.find((s) => s.id === state.activeSceneId)
        ?.environmentAssetId ??
        assets.find((a) => a.kind === "environment")?.id ??
        "",
    ): ValidationResult<true> {
      if (!name.trim() || name.trim().length > 120)
        return invalid("name", "Enter a scene name between 1 and 120 characters");
      const scene: ContentScene = {
        id: crypto.randomUUID(),
        name: name.trim(),
        environmentAssetId,
        startCamera: {
          position: [12, 16, 18],
          rotation: [
            -0.29962059992658957, 0.2752183320355054, 0.09071781822041597, 0.9089844021041025,
          ],
          fovDegrees: 40,
        },
        objects: [],
        hotspots: [],
        interactions: [],
        groups: [],
        zones: [],
        viewpoints: [],
        rules: [],
      };
      if (!project) projectAssets = new Map(assets.map((a) => [a.id, a.kind]));
      if (!project) {
        // The first scene starts a document; there must always be at least one scene.
        const upgradeObjects = (entries: readonly SceneObject[]): readonly ContentObject[] =>
          entries.map((entry) => ({ ...entry, parentId: null, visible: true, components: [] }));
        const document: ProjectDocument = {
          schemaVersion: 2,
          projectId: createProjectId(),
          title: "Untitled project",
          scenes: [{ ...scene, objects: upgradeObjects(state.objects) }],
        };
        const checked = deserializeProject(JSON.stringify(document), projectAssets);
        if (!checked.ok) return checked;
        const previous = history.getStates();
        project = freezeProject(checked.value);
        replaceState(fromProject(project, scene.id));
        const upgrade = (entry: State) =>
          fromProject(
            freezeProject({
              ...toContentProject(project!),
              scenes: [{ ...scene, objects: upgradeObjects(entry.objects) }],
            }),
            scene.id,
          );
        history.restoreStates(state, previous.past.map(upgrade), previous.future.map(upgrade));
        clearEdit();
        publish();
        return { ok: true, value: true };
      }
      return commitProject(
        { ...toContentProject(project), scenes: [...toContentProject(project).scenes, scene] },
        scene.id,
        "Create scene",
      );
    },
    setStartingViewpoint(id: string): ValidationResult<true> {
      const scene = project?.scenes.find((s) => s.id === state.activeSceneId);
      const view = scene?.viewpoints?.find((v) => v.id === id);
      if (!project || !scene || !view)
        return invalid("viewpoint", "Choose a saved view in this scene");
      return commitProject(
        {
          ...project,
          scenes: project.scenes.map((s) =>
            s.id === scene.id ? { ...s, startCamera: view.camera } : s,
          ),
        },
        scene.id,
        "Set starting view",
      );
    },
    deleteScene(id: string): ValidationResult<true> {
      const index = project?.scenes.findIndex((s) => s.id === id) ?? -1;
      if (!project || index < 0) return invalid("scene", "This scene no longer exists");
      if (project.scenes.length === 1)
        return invalid("scene", "Keep at least one scene in the project");
      if (
        project.scenes.some(
          (scene) =>
            scene.id !== id &&
            scene.interactions.some(
              (rule) =>
                rule.do.type === "navigate-scene" &&
                rule.do.sceneId.toLowerCase() === id.toLowerCase(),
            ),
        )
      )
        return invalid(
          "scene",
          "Change or remove interactions targeting this scene before deleting it",
        );
      const remaining = project.scenes.filter((s) => s.id !== id);
      const active =
        state.activeSceneId === id
          ? remaining[Math.min(index, remaining.length - 1)]!.id
          : state.activeSceneId!;
      // The full snapshot restores IDs, ordering, objects and views together.
      return commitProject({ ...project, scenes: remaining }, active, "Delete scene");
    },
    switchScene(id: string): ValidationResult<true> {
      if (!project?.scenes.some((s) => s.id === id))
        return invalid("scene", "This scene no longer exists");
      if (id === state.activeSceneId) return { ok: true, value: true };
      clearEdit();
      replaceState(fromProject(project, id));
      publish();
      return { ok: true, value: true };
    },
    renameScene(id: string, name: string): ValidationResult<true> {
      if (!project?.scenes.some((s) => s.id === id))
        return invalid("scene", "This scene no longer exists");
      if (!name.trim() || name.trim().length > 120)
        return invalid("name", "Enter a scene name between 1 and 120 characters");
      return commitProject(
        {
          ...project,
          scenes: project.scenes.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)),
        },
        id,
        "Rename scene",
      );
    },
    moveScene(id: string, index: number): ValidationResult<true> {
      if (!project) return invalid("scene", "Create a scene first");
      const from = project.scenes.findIndex((s) => s.id === id);
      if (from < 0 || !Number.isInteger(index) || index < 0 || index >= project.scenes.length)
        return invalid("scene", "Choose a valid scene position");
      const next = [...project.scenes];
      const [scene] = next.splice(from, 1);
      next.splice(index, 0, scene!);
      return commitProject({ ...project, scenes: next }, state.activeSceneId!, "Reorder scenes");
    },
    setEnvironment(assetId: string | null): ValidationResult<true> {
      if (!project) return invalid("scene", "Create a scene first");
      return commitProject(
        {
          ...project,
          scenes: project.scenes.map((s) =>
            s.id === state.activeSceneId ? { ...s, environmentAssetId: assetId } : s,
          ),
        },
        state.activeSceneId!,
        "Change environment",
      );
    },
    addViewpoint(name: string, camera: CameraPose): ValidationResult<true> {
      if (!name.trim() || name.trim().length > 120)
        return invalid("name", "Enter a viewpoint name between 1 and 120 characters");
      const checked = validateCameraPose(camera, "camera");
      if (!checked.ok) return checked;
      return editViews([
        ...(activeScene()?.viewpoints ?? []),
        { id: crypto.randomUUID(), name: name.trim(), camera: checked.value },
      ]);
    },
    renameViewpoint(id: string, name: string): ValidationResult<true> {
      if (!name.trim() || name.trim().length > 120)
        return invalid("name", "Enter a viewpoint name between 1 and 120 characters");
      if (!activeScene()?.viewpoints?.some((v) => v.id === id))
        return invalid("viewpoint", "This viewpoint no longer exists");
      return editViews(
        (activeScene()?.viewpoints ?? []).map((v) =>
          v.id === id ? { ...v, name: name.trim() } : v,
        ),
      );
    },
    moveViewpoint(id: string, targetIndex: number): ValidationResult<true> {
      const current = activeScene()?.viewpoints ?? [];
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
      if (!activeScene()?.viewpoints?.some((v) => v.id === id))
        return invalid("viewpoint", "This viewpoint no longer exists");
      if (
        activeScene()?.interactions.some(
          (rule) =>
            rule.do.type === "move-to-viewpoint" &&
            rule.do.viewpointId.toLowerCase() === id.toLowerCase(),
        )
      )
        return invalid(
          "viewpoint",
          "Change or remove interactions targeting this viewpoint before deleting it",
        );
      return editViews((activeScene()?.viewpoints ?? []).filter((v) => v.id !== id));
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
      options: { allowDraftLinks?: boolean } = {},
    ): ValidationResult<ProjectDocument> {
      // Finish all checks before touching the open project or its undo history
      const result = deserializeProject(text, assetKinds, options);
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
      loadGeneration++;
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
          const legacy = (entry: HistoryState, views: readonly NamedViewpoint[] | undefined) => {
            const updated = {
              ...scene,
              objects: isHierarchyState(entry) ? entry.objects : entry,
              ...(isHierarchyState(entry)
                ? { groups: entry.groups, name: entry.sceneName ?? scene.name }
                : {}),
              ...(views ? { viewpoints: views } : {}),
            };
            return fromProject(
              freezeProject({
                ...loaded,
                scenes: [updated, ...loaded.scenes.slice(1)],
              } as ProjectDocument),
              scene.id,
            );
          };
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
      if (parentId !== null && parentId !== activeScene()?.id) {
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
