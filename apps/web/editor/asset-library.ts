import { searchAssets, type CatalogueAsset } from "../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object";
import type { ProjectDocument } from "../shared/project/project-types";
import type { createDocumentStore } from "./document-store";

type LibrarySnapshot = Readonly<{
  mode: "closed" | "browsing" | "placing";
  query: string;
  results: readonly CatalogueAsset[];
  assetId: string | null;
}>;

// UI-independent search and placement through the existing document commands
// The popup renders this state and the viewport supplies the final scene position
export function createAssetLibrary(
  assets: readonly CatalogueAsset[],
  store: ReturnType<typeof createDocumentStore>,
) {
  // Environment selection already has its own project-creation flow
  // Only approved placeable models belong to this picker
  const models = Object.freeze(assets.filter((asset) => asset.kind === "model"));
  let snapshot: LibrarySnapshot = Object.freeze({
    mode: "closed",
    query: "",
    results: models,
    assetId: null,
  });
  let document: ProjectDocument | null = null;
  let parentId: string | null = null;
  const listeners = new Set<() => void>();

  function publish(next: LibrarySnapshot) {
    snapshot = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }
  function cancel() {
    // Closing or cancelling never creates a placement command or changes project history
    document = null;
    publish({ ...snapshot, mode: "closed", assetId: null });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(selectedId: string | null = null) {
      // Reopening replaces any pending pick while retaining the user's search text
      document = null;
      parentId = selectedId;
      publish({ ...snapshot, mode: "browsing", assetId: null });
    },
    search(query: string) {
      // Search is literal, case-insensitive name matching with catalogue order preserved
      // Categories/tags remain deferred until the actual filter list is agreed
      publish({ ...snapshot, query, results: Object.freeze(searchAssets(models, query)) });
    },
    choose(assetId: string): { ok: true } | { ok: false; error: string } {
      if (snapshot.mode !== "browsing" || !snapshot.results.some((asset) => asset.id === assetId)) {
        return { ok: false, error: "Choose an asset from the current library results" };
      }
      const project = store.getSnapshot().project;
      if (project === null) {
        return { ok: false, error: "Choose a room first" };
      }

      // Choosing closes the picker but does not place an object at an arbitrary origin
      // Capture the document so a late viewport click cannot add to a replaced or edited project
      document = project;
      publish({ ...snapshot, mode: "placing", assetId });
      return { ok: true };
    },
    place(
      position: Vector3Tuple,
    ): { ok: true; object: SceneObject } | { ok: false; error: string } {
      if (snapshot.mode !== "placing" || snapshot.assetId === null) {
        return { ok: false, error: "Choose an asset before placing it" };
      }
      if (document !== store.getSnapshot().project) {
        cancel();
        return { ok: false, error: "The scene changed; choose the asset again" };
      }
      // Reject malformed coordinates before the existing command validates bounds and asset access
      // Keep a failed pick pending so the author can try another valid location
      if (position.length !== 3 || !position.every(Number.isFinite)) {
        return { ok: false, error: "Choose a valid position in the scene" };
      }
      // Room instances start as siblings even when another room or furnishing is selected
      const result = store.addObject(
        snapshot.assetId,
        position,
        snapshot.assetId === "test-room-module-v1" ? null : parentId,
      );
      if (result.ok) {
        cancel();
      }
      return result;
    },
    cancel,
  };
}
