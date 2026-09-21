import { sampleAsset } from "../shared/assets/sample-asset.ts";
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
    Object.freeze(scene.objects);
    Object.freeze(scene.startCamera.position);
    Object.freeze(scene.startCamera.rotation);
    Object.freeze(scene.startCamera);
    Object.freeze(scene);
  }
  Object.freeze(project.scenes);
  return Object.freeze(project);
}

export function createDocumentStore() {
  let objects: readonly SceneObject[] = Object.freeze([]);
  // The current grid-only editor has no environment-backed project at startup
  // Keep that explicit until a complete project is loaded
  let project: ProjectDocument | null = null;
  let projectAssets: ReadonlyMap<string, string> = new Map();
  // ponytail: AddObject history only; introduce command variants with the next edit type
  const undoStack: SceneObject[] = [];
  const redoStack: SceneObject[] = [];
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

  return {
    getSnapshot: () => snapshot,
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
    addObject(position: Vector3Tuple) {
      if (project !== null && projectAssets.get(sampleAsset.id) !== "model") {
        return {
          ok: false,
          error: "The sample asset is unavailable in this project's catalog.",
        } as const;
      }
      if (!position.every((value) => Number.isFinite(value) && Math.abs(value) <= 10_000)) {
        return { ok: false, error: "Choose a position inside the scene." } as const;
      }
      if (objects.length >= 200) {
        return { ok: false, error: "This scene has reached its 200-object limit." } as const;
      }
      const object: SceneObject = Object.freeze({
        id: crypto.randomUUID(),
        name: `${sampleAsset.name} ${objects.length + 1}`,
        assetId: sampleAsset.id,
        transform: Object.freeze({
          position: Object.freeze([...position] as [number, number, number]),
          rotation: Object.freeze([0, 0, 0, 1] as const),
          scale: Object.freeze([1, 1, 1] as const),
        }),
      });
      replaceObjects([...objects, object]);
      undoStack.push(object);
      if (undoStack.length > 100) {
        undoStack.shift();
      }
      redoStack.length = 0;
      publish();
      return { ok: true, object } as const;
    },
    undo() {
      const object = undoStack.pop();
      if (object === undefined) {
        return;
      }
      replaceObjects(objects.filter((entry) => entry.id !== object.id));
      redoStack.push(object);
      publish();
    },
    redo() {
      const object = redoStack.pop();
      if (object === undefined) {
        return;
      }
      replaceObjects([...objects, object]);
      undoStack.push(object);
      publish();
    },
  };
}
