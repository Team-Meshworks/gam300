import { sampleAsset } from "../shared/assets/sample-asset.ts";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object.ts";

export function createDocumentStore() {
  let objects: readonly SceneObject[] = Object.freeze([]);
  // ponytail: AddObject history only; introduce command variants with the next edit type
  const undoStack: SceneObject[] = [];
  const redoStack: SceneObject[] = [];
  const listeners = new Set<() => void>();
  let snapshot: Readonly<{
    objects: readonly SceneObject[];
    canUndo: boolean;
    canRedo: boolean;
  }> = Object.freeze({ objects, canUndo: false, canRedo: false });

  function publish() {
    snapshot = Object.freeze({
      objects,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    });
    listeners.forEach((listener) => listener());
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addObject(position: Vector3Tuple) {
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
      objects = Object.freeze([...objects, object]);
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
      objects = Object.freeze(objects.filter((entry) => entry.id !== object.id));
      redoStack.push(object);
      publish();
    },
    redo() {
      const object = redoStack.pop();
      if (object === undefined) {
        return;
      }
      objects = Object.freeze([...objects, object]);
      undoStack.push(object);
      publish();
    },
  };
}
