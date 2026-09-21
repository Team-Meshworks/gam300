import { createCommandHistory } from "./command-history";
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
  // Keep that explicit until a complete project is loaded
  let project: ProjectDocument | null = null;
  let projectAssets: ReadonlyMap<string, string> = new Map();
  // Keep history here so the buttons and future edit controls share one undo order.
  const history = createCommandHistory<readonly SceneObject[]>();
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
      canUndo: history.canUndo,
      canRedo: history.canRedo,
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
      history.clear();
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
        history.execute(objects, {
          label: "Add object",
          apply: (current) => Object.freeze([...current, object]),
          revert: (current) => Object.freeze(current.filter((entry) => entry.id !== object.id)),
        }),
      );
      publish();
      return { ok: true, object } as const;
    },
    undo() {
      const next = history.undo(objects);
      // Nothing changed, so there is no new snapshot to send to the UI.
      if (next === objects) return;
      replaceObjects(next);
      publish();
    },
    redo() {
      const next = history.redo(objects);
      if (next === objects) return;
      replaceObjects(next);
      publish();
    },
  };
}
