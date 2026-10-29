import { assetCategories, searchAssets, type CatalogueAsset } from "../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object";
import type { ProjectDocument } from "../shared/project/project-types";
import type { createDocumentStore } from "./document-store";

type LibrarySnapshot = Readonly<{
  mode: "closed" | "browsing" | "placing";
  query: string;
  category: (typeof assetCategories)[number];
  results: readonly CatalogueAsset[];
  assetId: string | null;
  canRemove: boolean;
}>;

// UI-independent behavior for ordinary placement and placement on an existing case
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
    category: "All",
    results: models,
    assetId: null,
    canRemove: false,
  });
  let document: ProjectDocument | null = null;
  let target: { id: string; position: Vector3Tuple } | null = null;
  let parentId: string | null = null;
  const listeners = new Set<() => void>();

  function publish(next: LibrarySnapshot) {
    snapshot = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }
  function cancel() {
    // Closing or cancelling never creates a placement command or changes project history
    document = null;
    target = null;
    publish({ ...snapshot, mode: "closed", assetId: null, canRemove: false });
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
      target = null;
      parentId = selectedId;
      publish({ ...snapshot, mode: "browsing", assetId: null, canRemove: false });
    },
    openOnCase(id: string, position: Vector3Tuple) {
      // Capture the exact document and surface so edits while browsing cannot target a stale case
      const current = store.getSnapshot();
      if (!current.project || !current.objects.some((object) => object.id === id)) {
        return { ok: false, error: "Choose a placed display case" } as const;
      }
      document = current.project;
      target = { id, position: [...position] };
      const displayed =
        current.project.schemaVersion === 2
          ? current.project.scenes[0]!.objects.filter(
              (object) => object.parentId?.toLowerCase() === id.toLowerCase(),
            )
          : [];
      publish({ ...snapshot, mode: "browsing", assetId: null, canRemove: displayed.length === 1 });
      return { ok: true } as const;
    },
    remove() {
      // A stale picker must never remove content from a newer document or another case
      if (snapshot.mode !== "browsing" || target === null || !snapshot.canRemove) {
        return { ok: false, error: "Choose an occupied display case" } as const;
      }
      if (document !== store.getSnapshot().project) {
        cancel();
        return { ok: false, error: "The scene changed; choose the display case again" } as const;
      }
      const result = store.removeDisplayedAsset(target.id);
      if (!result.ok) return { ok: false, error: result.error.message } as const;
      cancel();
      return { ok: true } as const;
    },
    search(query: string) {
      // Search is literal, case-insensitive name matching with catalogue order preserved
      // The current category stays active while the user changes the search text
      publish({
        ...snapshot,
        query,
        results: Object.freeze(searchAssets(models, query, snapshot.category)),
      });
    },
    // Reject unknown category values without disturbing the picker or current project
    filter(category: string) {
      const selected = assetCategories.find((value) => value === category);
      if (selected === undefined) {
        return false;
      }
      publish({
        ...snapshot,
        category: selected,
        results: Object.freeze(searchAssets(models, snapshot.query, selected)),
      });
      return true;
    },
    choose(assetId: string): { ok: true } | { ok: false; error: string } {
      if (snapshot.mode !== "browsing" || !snapshot.results.some((asset) => asset.id === assetId)) {
        return { ok: false, error: "Choose an asset from the current library results" };
      }
      const project = store.getSnapshot().project;
      if (project === null) {
        return { ok: false, error: "Choose a room first" };
      }

      if (target !== null) {
        // Choosing for a case places immediately and closes only after the atomic command succeeds
        if (project !== document) {
          cancel();
          return { ok: false, error: "The scene changed; choose the display case again" };
        }
        const placed = store.addAttachedObject(assetId, target.id, target.position);
        if (placed.ok) cancel();
        return placed;
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
