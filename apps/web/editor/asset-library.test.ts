import { describe, expect, it } from "vitest";
import { createAssetLibrary } from "./asset-library";
import { createDocumentStore } from "./document-store";
import type { ContentObject } from "../shared/project/project-content";
import { serializeProject } from "../shared/project/project-serialization";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";

// Small catalogue fixtures exercise behavior without loading models or the popup
const assets: CatalogueAsset[] = [
  {
    id: "room",
    name: "Room",
    kind: "environment",
    url: "/room.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
  {
    id: "vase",
    name: "Blue Vase",
    kind: "model",
    url: "/vase.glb",
    sha256: "0".repeat(64),
    thumbnail: null,
  },
];

// Start every picker flow with its own room-backed project and independent history
function setup() {
  const store = createDocumentStore(assets);
  store.createProject("room");
  return { store, library: createAssetLibrary(assets, store) };
}

describe("asset library behavior without a popup implementation", () => {
  it("searches approved models, closes on choice and places through the existing undo command", () => {
    const { store, library } = setup();
    const before = store.getSnapshot();
    library.open();

    // Browsing changes picker state only; the viewport click creates the command
    library.search(" BLUE ");
    expect(library.getSnapshot().results.map((asset) => asset.id)).toEqual(["vase"]);
    expect(library.choose("vase").ok).toBe(true);
    expect(library.getSnapshot().mode).toBe("placing");
    expect(store.getSnapshot()).toBe(before);

    // The committed placement closes the picker and restores the same ID on Redo
    expect(library.place([2, 0, 3]).ok).toBe(true);
    const object = store.getSnapshot().objects[0]!;
    expect(object.transform.position).toEqual([2, 0, 3]);
    expect(library.getSnapshot().mode).toBe("closed");
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.redo();
    expect(store.getSnapshot().objects[0]!.id).toBe(object.id);
    expect(library.place([1, 0, 1]).ok).toBe(false);
  });
  it("rejects unknown, environment and hidden results without changing the document", () => {
    const { store, library } = setup();
    const before = store.getSnapshot();
    library.open();

    // A stale or forged result cannot select hidden assets or environment entries
    expect(library.choose("missing").ok).toBe(false);
    expect(library.choose("room").ok).toBe(false);
    library.search("nothing");
    expect(library.choose("vase").ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
  it("cancels without history and keeps invalid placement retryable", () => {
    const { store, library } = setup();
    const before = store.getSnapshot();
    library.open();
    library.choose("vase");

    // Invalid coordinates retain the pending choice so the author can retry or cancel
    expect(library.place([NaN, 0, 0]).ok).toBe(false);
    expect(library.place([10001, 0, 0]).ok).toBe(false);
    expect(library.getSnapshot().mode).toBe("placing");
    library.cancel();
    expect(store.getSnapshot()).toBe(before);
  });
  it("discards a stale pick after project replacement", () => {
    const { store, library } = setup();
    library.open();
    library.choose("vase");

    // A new document invalidates the captured choice even when it uses the same room
    store.resetProject();
    store.createProject("room");
    expect(library.place([0, 0, 0]).ok).toBe(false);
    expect(store.getSnapshot().objects).toHaveLength(0);
    expect(library.getSnapshot().mode).toBe("closed");
  });
  it("attaches to the chosen case atomically and preserves movement through undo, save and recovery", () => {
    const { store, library } = setup();
    const first = store.addObject("vase", [0, 0, 0]);
    const second = store.addObject("vase", [5, 0, 0]);
    if (!first.ok || !second.ok) throw new Error("case setup failed");

    // Target the second case explicitly so placement cannot silently use the first
    library.openOnCase(second.object.id, [5, 1, 0]);
    expect(library.choose("vase").ok).toBe(true);
    expect(library.getSnapshot().mode).toBe("closed");

    // Membership and placement share one history entry with stable child identity
    const child = store.getSnapshot().objects[2] as ContentObject;
    expect(child.parentId).toBe(second.object.id);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(2);
    store.redo();
    expect(store.getSnapshot().objects[2]!.id).toBe(child.id);

    // Moving the chosen case carries its displayed child and leaves the other case alone
    expect(
      store.setTransform(second.object.id, { ...second.object.transform, position: [7, 0, 0] }).ok,
    ).toBe(true);
    expect(store.getSnapshot().objects[2]!.transform.position).toEqual([7, 1, 0]);
    expect(store.getSnapshot().objects[0]!.transform.position).toEqual([0, 0, 0]);
    const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));

    // Recover both document and history, then continue moving the same attachment
    const encoded = serializeProject(store.getSnapshot().project, kinds);
    if (!encoded.ok) throw new Error(encoded.error.message);
    const reopened = createDocumentStore(assets);
    expect(reopened.loadProject(encoded.value, kinds, store.getRecoveryHistory()).ok).toBe(true);
    reopened.undo();
    expect(reopened.getSnapshot().objects[2]!.transform.position).toEqual([5, 1, 0]);
    reopened.redo();
    expect(reopened.getSnapshot().objects[2]!.transform.position).toEqual([7, 1, 0]);
    expect(
      reopened.setTransform(second.object.id, { ...second.object.transform, position: [8, 0, 0] })
        .ok,
    ).toBe(true);
    expect(reopened.getSnapshot().objects[2]!.transform.position).toEqual([8, 1, 0]);
  });
  it("rotates and uniformly resizes nested attachments and rejects distortion without changing history", () => {
    const { store } = setup();
    const root = store.addObject("vase", [0, 0, 0]);
    if (!root.ok) throw new Error(root.error);
    const child = store.addAttachedObject("vase", root.object.id, [1, 1, 0]);
    if (!child.ok) throw new Error(child.error);
    const nested = store.addAttachedObject("vase", child.object.id, [1, 2, 0]);
    expect(nested.ok).toBe(true);

    // A nested child follows the full ancestor transform rather than translation alone
    const rotated = {
      position: [0, 0, 0],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      scale: [2, 2, 2],
    };
    expect(store.setTransform(root.object.id, rotated).ok).toBe(true);
    const position = store.getSnapshot().objects[2]!.transform.position;
    expect(position[0]).toBeCloseTo(0);
    expect(position[1]).toBeCloseTo(4);
    expect(position[2]).toBeCloseTo(-2);
    const before = store.getSnapshot();

    // Reject distortion; parent deletion removes its branch in one reversible command.
    expect(store.setTransform(root.object.id, { ...rotated, scale: [2, 3, 2] }).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.deleteObject(root.object.id).ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(0);
    store.undo();
    expect(store.getSnapshot().project).toEqual(before.project);
  });
  it("rejects stale cases and invalid surfaces without leaving a partial placement", () => {
    const { store, library } = setup();
    const root = store.addObject("vase", [0, 0, 0]);
    if (!root.ok) throw new Error(root.error);
    const before = store.getSnapshot();

    // Neither an invalid target nor a malformed display anchor may leave a partial child
    expect(library.openOnCase("missing", [0, 1, 0]).ok).toBe(false);
    library.openOnCase(root.object.id, [0, NaN, 0]);
    expect(library.choose("vase").ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    library.openOnCase(root.object.id, [0, 1, 0]);

    // Deleting the case while its picker is open invalidates the captured document
    store.deleteObject(root.object.id);
    expect(library.choose("vase").ok).toBe(false);
    expect(store.getSnapshot().objects).toHaveLength(0);
  });
  it("replaces one display slot and removes it with atomic undo and stable references", () => {
    const catalogue = [...assets, { ...assets[1]!, id: "crate", name: "Crate" }];
    const store = createDocumentStore(catalogue);
    store.createProject("room");
    const library = createAssetLibrary(catalogue, store);
    const placed = store.addObject("vase", [0, 0, 0]);
    if (!placed.ok) throw new Error(placed.error);
    const id = placed.object.id;
    library.openOnCase(id, [0, 1, 0]);
    expect(library.getSnapshot().canRemove).toBe(false);
    expect(library.choose("vase").ok).toBe(true);

    // Replacing the occupied slot retains the displayed object ID for existing references
    const original = store.getSnapshot().objects[1]!;
    library.openOnCase(id, [0, 1, 0]);
    expect(library.getSnapshot().canRemove).toBe(true);
    expect(library.choose("crate").ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(2);
    expect(store.getSnapshot().objects[1]).toMatchObject({ id: original.id, assetId: "crate" });
    store.undo();
    expect(store.getSnapshot().objects[1]).toEqual(original);
    store.redo();
    library.openOnCase(id, [0, 1, 0]);

    // Removing content preserves its case and Undo restores the same displayed object
    expect(library.remove().ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([id]);
    store.undo();
    expect(store.getSnapshot().objects[1]).toMatchObject({ id: original.id, assetId: "crate" });
    library.openOnCase(id, [0, 1, 0]);

    // A case moved during browsing must be selected again before removing its content
    store.setTransform(id, { ...placed.object.transform, position: [2, 0, 0] });
    const before = store.getSnapshot();
    expect(library.remove().ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);

    // Descendants survive replacement; removing their parent removes the whole nested branch.
    expect(store.addAttachedObject("vase", original.id, [2, 2, 0]).ok).toBe(true);
    library.openOnCase(id, [2, 1, 0]);
    expect(library.choose("vase").ok).toBe(true);
    library.openOnCase(id, [2, 1, 0]);
    const referenced = store.getSnapshot();
    expect(library.remove().ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([id]);
    store.undo();
    expect(store.getSnapshot().project).toEqual(referenced.project);
  });
  it("removes displayed content from the active second scene and restores it with Undo", () => {
    const { store, library } = setup();
    const firstSceneId = store.getSnapshot().activeSceneId!;
    expect(store.createScene("Second scene", "room").ok).toBe(true);
    const secondSceneId = store.getSnapshot().activeSceneId!;
    const placed = store.addObject("vase", [0, 0, 0]);
    if (!placed.ok) throw new Error(placed.error);

    // Populate a case outside scene zero so occupancy follows the same scene as placement
    expect(library.openOnCase(placed.object.id, [0, 1, 0]).ok).toBe(true);
    expect(library.choose("vase").ok).toBe(true);
    const displayed = store.getSnapshot().objects[1]!;
    expect(library.openOnCase(placed.object.id, [0, 1, 0]).ok).toBe(true);
    expect(library.getSnapshot().canRemove).toBe(true);
    expect(library.remove().ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([placed.object.id]);

    // Undo restores the same attachment while the first scene remains untouched
    store.undo();
    expect(store.getSnapshot().activeSceneId).toBe(secondSceneId);
    expect(store.getSnapshot().objects[1]).toEqual(displayed);
    expect(store.switchScene(firstSceneId).ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(0);
  });
  it("places multiple room modules in one scene and retains them across serialization and undo", () => {
    // These generic room fixtures check repeated placement independently of Starter room snapping
    const module = { ...assets[1]!, id: "room-module", name: "Starter room" };
    const catalogue = [...assets, module];
    const store = createDocumentStore(catalogue);
    store.createProject("room");
    const library = createAssetLibrary(catalogue, store);
    for (const x of [10, 20]) {
      library.open();
      expect(library.choose(module.id).ok).toBe(true);
      expect(library.place([x, 0, 0]).ok).toBe(true);
    }

    // Reopening preserves distinct instances and their recoverable placement order
    const project = store.getSnapshot().project!;
    expect(project.scenes).toHaveLength(1);
    expect(project.scenes[0]!.objects).toHaveLength(2);
    expect(new Set(project.scenes[0]!.objects.map((object) => object.id)).size).toBe(2);
    const kinds = new Map(catalogue.map((asset) => [asset.id, asset.kind]));
    const saved = serializeProject(project, kinds);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(store.loadProject(saved.value, kinds, store.getRecoveryHistory()).ok).toBe(true);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(1);
    store.redo();
    expect(store.getSnapshot().objects.map((object) => object.transform.position[0])).toEqual([
      10, 20,
    ]);
  });
  it("replaces one slot and restores removal without losing the display case", () => {
    const store = createDocumentStore([...assets, { ...assets[1]!, id: "crate", name: "Crate" }]);
    store.createProject("room");
    const placed = store.addObject("vase", [0, 0, 0]);
    if (!placed.ok) throw new Error(placed.error);
    const id = placed.object.id;

    // Exercise the store entry point directly, without the picker guarding its arguments
    const first = store.addAttachedObject("vase", id, [0, 1, 0]);
    if (!first.ok) throw new Error(first.error);
    expect(store.addAttachedObject("crate", id, [0, 2, 0]).ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(2);
    expect(store.getSnapshot().objects[1]).toMatchObject({
      id: first.object.id,
      assetId: "crate",
      transform: first.object.transform,
    });
    store.undo();
    expect(store.getSnapshot().objects[1]).toEqual(first.object);
    store.redo();
    expect(store.removeDisplayedAsset(id).ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([id]);
    store.undo();
    expect(store.getSnapshot().objects[1]!.id).toBe(first.object.id);
    const fitted = {
      position: [0, 2, 0] as const,
      rotation: [0, 0, 0, 1] as const,
      scale: [0.2, 0.2, 0.2] as const,
    };
    const resized = store.addAttachedObject("vase", id, fitted.position, fitted);
    if (!resized.ok) throw new Error(resized.error);
    expect(resized.object.transform).toEqual(fitted);
    store.undo();
    expect(store.getSnapshot().objects[1]!.transform).toEqual(first.object.transform);
    store.redo();
    expect(store.getSnapshot().objects[1]!.transform).toEqual(fitted);
    const before = store.getSnapshot();

    // Invalid model and parent references leave the complete previous snapshot untouched
    expect(store.addAttachedObject("missing", id, [0, 1, 0]).ok).toBe(false);
    expect(store.addAttachedObject("vase", "missing", [0, 1, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
});

it("combines the approved 3D category with search without changing the project", () => {
  // Give every approved category a distinct asset so category matching is observable
  const catalogue: CatalogueAsset[] = [
    ...assets,
    { ...assets[1]!, id: "chair", name: "Blue Chair", category: "Furniture" },
    { ...assets[1]!, id: "urn", name: "Blue Urn", category: "Objects" },
    { ...assets[1]!, id: "wall", name: "Stone Wall", category: "Architecture" },
    { ...assets[1]!, id: "shirt", name: "Blue Shirt", category: "Clothing" },
    { ...assets[1]!, id: "hammer", name: "Blue Hammer", category: "Tools & Equipment" },
  ];
  const store = createDocumentStore(catalogue);
  store.createProject("room");
  const library = createAssetLibrary(catalogue, store);
  const before = store.getSnapshot();
  library.open();

  // Search and category intersect; a hidden result cannot be chosen by its ID
  library.search(" BLUE ");
  expect(library.filter("Furniture")).toBe(true);
  expect(library.getSnapshot().results.map((asset) => asset.id)).toEqual(["chair"]);
  expect(library.choose("urn").ok).toBe(false);
  for (const [category, id] of [
    ["Objects", "urn"],
    ["Clothing", "shirt"],
    ["Tools & Equipment", "hammer"],
  ]) {
    expect(library.filter(category!)).toBe(true);
    expect(library.getSnapshot().results.map((asset) => asset.id)).toEqual([id]);
  }

  // Clearing search retains the category and reveals the previously unmatched asset
  library.filter("Architecture");
  expect(library.getSnapshot().results).toEqual([]);
  library.search("");
  expect(library.getSnapshot().results.map((asset) => asset.id)).toEqual(["wall"]);

  // Invalid filters preserve picker identity, while reopening retains the last valid category
  const picker = library.getSnapshot();
  expect(library.filter("not a category")).toBe(false);
  expect(library.getSnapshot()).toBe(picker);
  library.cancel();
  library.open();
  expect(library.getSnapshot().category).toBe("Architecture");
  expect(store.getSnapshot()).toBe(before);

  // All restores the original model order without admitting the environment entry
  library.filter("All");
  expect(library.getSnapshot().results).toEqual(
    catalogue.filter((asset) => asset.kind === "model"),
  );

  // A filtered result still uses normal placement and Undo through the shared store
  library.filter("Furniture");
  expect(library.choose("chair").ok).toBe(true);
  expect(library.place([2, 0, 3]).ok).toBe(true);
  store.undo();
  expect(store.getSnapshot().objects).toEqual(before.objects);
});
