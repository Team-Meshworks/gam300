import { expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import fixture from "../shared/project/fixtures/m1-project.json";

it("returns New to room selection without carrying undo into the next project", () => {
  const store = createDocumentStore([]);
  const kinds = new Map([["test-room-v1", "environment"], ["test-crate-v1", "model"]]);
  const loaded = store.loadProject(JSON.stringify(fixture), kinds);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const object = store.getSnapshot().objects[0]!;
  store.setTransform(object.id, { ...object.transform, position: [3, 0, 0] });
  expect(store.getSnapshot().canUndo).toBe(true);

  // Reset is a project boundary; undo must not bring the previous project's objects back
  store.resetProject();
  expect(store.getSnapshot()).toMatchObject({ project: null, objects: [], canUndo: false, canRedo: false });
  store.undo();
  expect(store.getSnapshot().project).toBe(null);
  expect(store.getRecoveryHistory()).toBeUndefined();
});
