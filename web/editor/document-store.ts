import type { CatalogueAsset } from "../shared/assets/catalogue.ts";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object.ts";
import { deserializeProject } from "../shared/project/project-deserialization";
import type { ProjectDocument, Transform } from "../shared/project/project-types";
import { validateTransform } from "../shared/project/spatial-validation";
import type { ValidationResult } from "../shared/project/validation-helpers";

type Command =
  | { kind: "add"; object: SceneObject }
  | { kind: "transform"; id: string; before: Transform; after: Transform };

function freezeTransform(transform: Transform): Transform {
  Object.freeze(transform.position);
  Object.freeze(transform.rotation);
  Object.freeze(transform.scale);
  return Object.freeze(transform);
}

function freezeProject(project: ProjectDocument): ProjectDocument {
  // Freeze the reader's separate copy before exposing it to panels or commands
  for (const scene of project.scenes) {
    for (const object of scene.objects) {
      freezeTransform(object.transform);
      Object.freeze(object);
    }
    Object.freeze(scene.objects);
    Object.freeze(scene.startCamera.position);
    Object.freeze(scene.startCamera.rotation);
    Object.freeze(scene.startCamera);
    Object.freeze(scene);
  }
  Object.freeze(project.scenes);
  return Object.freeze(project);
}

export function createDocumentStore(assets: readonly CatalogueAsset[]) {
  let objects: readonly SceneObject[] = Object.freeze([]);
  // The current grid-only editor has no environment-backed project at startup
  // Choosing a room creates the project; imports can supply one directly
  let project: ProjectDocument | null = null;
  let projectAssets: ReadonlyMap<string, string> = new Map();
  const undoStack: Command[] = [];
  const redoStack: Command[] = [];
  const listeners = new Set<() => void>();
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
      project = Object.freeze({
        ...project,
        scenes: Object.freeze([Object.freeze({ ...scene, objects })]),
      });
    }
  }

  function publish() {
    snapshot = Object.freeze({
      objects,
      project,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    });
    listeners.forEach((listener) => listener());
  }

  function replaceTransform(id: string, transform: Transform) {
    replaceObjects(
      objects.map((object) =>
        object.id === id ? Object.freeze({ ...object, transform }) : object,
      ),
    );
  }

  function apply(command: Command, reverse: boolean) {
    if (command.kind === "add") {
      replaceObjects(
        reverse
          ? objects.filter((object) => object.id !== command.object.id)
          : [...objects, command.object],
      );
    } else {
      replaceTransform(command.id, reverse ? command.before : command.after);
    }
  }

  function record(command: Command) {
    undoStack.push(command);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    publish();
  }

  return {
    getSnapshot: () => snapshot,
    createProject(environmentAssetId: string): ValidationResult<ProjectDocument> {
      // Room choice supplies the environment required by the saved format
      // Keep any models already placed on the grid and their undo commands
      if (project !== null) {
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
            objects,
          },
        ],
      };
      // Run the import checks before replacing anything in memory
      // A bad asset reference leaves the grid scene and history available
      const checked = deserializeProject(JSON.stringify(candidate), kinds);
      if (!checked.ok) return checked;
      project = freezeProject(checked.value);
      objects = project.scenes[0]!.objects;
      projectAssets = kinds;
      publish();
      return { ok: true, value: project };
    },
    loadProject(
      text: unknown,
      assetKinds: ReadonlyMap<string, string>,
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

      project = loaded;
      objects = scene.objects;
      projectAssets = loadedAssets;
      // Undo from the previous project must never reintroduce its objects here
      undoStack.length = 0;
      redoStack.length = 0;
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
        transform: freezeTransform({
          position: Object.freeze([...position] as [number, number, number]),
          rotation: Object.freeze([0, 0, 0, 1] as const),
          scale: Object.freeze([1, 1, 1] as const),
        }),
      });
      replaceObjects([...objects, object]);
      record({ kind: "add", object });
      return { ok: true, object } as const;
    },
    setTransform(id: string, raw: unknown) {
      const object = objects.find((entry) => entry.id === id);
      if (object === undefined) {
        return { ok: false, error: "Select an object in this scene." } as const;
      }
      const result = validateTransform(raw);
      if (!result.ok) {
        return { ok: false, error: `${result.error.path}: ${result.error.message}` } as const;
      }
      const before = object.transform;
      const after = result.value;
      if (
        before.position.every((value, index) => value === after.position[index]) &&
        before.rotation.every((value, index) => value === after.rotation[index]) &&
        before.scale.every((value, index) => value === after.scale[index])
      ) {
        return { ok: true, changed: false } as const;
      }
      freezeTransform(after);
      replaceTransform(id, after);
      record({ kind: "transform", id, before, after });
      return { ok: true, changed: true } as const;
    },
    undo() {
      const command = undoStack.pop();
      if (command === undefined) {
        return;
      }
      apply(command, true);
      redoStack.push(command);
      publish();
    },
    redo() {
      const command = redoStack.pop();
      if (command === undefined) {
        return;
      }
      apply(command, false);
      undoStack.push(command);
      publish();
    },
  };
}
