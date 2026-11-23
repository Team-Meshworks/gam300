import { createLoadedStore } from "../tests/project-store-fixture";
import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
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

describe("asset placement and display attachments", () => {
  it("attaches to the chosen case atomically and preserves movement through undo, save and recovery", () => {
    const store = createLoadedStore(assets, "room");
    const first = store.addObject("vase", [0, 0, 0]);
    const second = store.addObject("vase", [5, 0, 0]);
    if (!first.ok || !second.ok) throw new Error("case setup failed");

    // Target the second case explicitly so placement cannot silently use the first
    const attached = store.addAttachedObject("vase", second.object.id, [5, 1, 0]);
    if (!attached.ok) throw new Error(attached.error);

    // Membership and placement share one history entry with stable child identity
    const { project, activeSceneId } = store.getSnapshot();
    if (project?.schemaVersion !== 2) throw new Error("Expected an authored v2 project");
    const child = project.scenes.find((scene) => scene.id === activeSceneId)?.objects[2];
    expect(child?.id).toBe(attached.object.id);
    expect(child?.parentId).toBe(second.object.id);
    store.undo();
    expect(store.getSnapshot().objects).toHaveLength(2);
    store.redo();
    expect(store.getSnapshot().objects[2]!.id).toBe(attached.object.id);

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
    const store = createLoadedStore(assets, "room");
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
    const store = createLoadedStore(assets, "room");
    const root = store.addObject("vase", [0, 0, 0]);
    if (!root.ok) throw new Error(root.error);
    const before = store.getSnapshot();

    expect(store.addAttachedObject("vase", root.object.id, [0, NaN, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);

    expect(store.deleteObject(root.object.id).ok).toBe(true);
    const deleted = store.getSnapshot();
    expect(store.addAttachedObject("vase", root.object.id, [0, 1, 0]).ok).toBe(false);
    expect(store.getSnapshot()).toBe(deleted);
  });
  it("preserves display descendants on replacement and restores the removed branch with Undo", () => {
    const catalogue = [...assets, { ...assets[1]!, id: "crate", name: "Crate" }];
    const store = createLoadedStore(catalogue, "room");
    const placed = store.addObject("vase", [0, 0, 0]);
    if (!placed.ok) throw new Error(placed.error);
    const id = placed.object.id;
    const original = store.addAttachedObject("vase", id, [0, 1, 0]);
    if (!original.ok) throw new Error(original.error);

    // Descendants survive replacement; removing their parent removes the whole nested branch.
    const descendant = store.addAttachedObject("vase", original.object.id, [0, 2, 0]);
    if (!descendant.ok) throw new Error(descendant.error);
    expect(store.addAttachedObject("crate", id, [0, 1, 0]).ok).toBe(true);
    const referenced = store.getSnapshot();
    expect(referenced.objects[1]).toMatchObject({ id: original.object.id, assetId: "crate" });
    expect(referenced.objects[2]).toEqual(descendant.object);
    expect(store.removeDisplayedAsset(id).ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([id]);
    store.undo();
    expect(store.getSnapshot().project).toEqual(referenced.project);
  });
  it("removes displayed content from the active second scene and restores it with Undo", () => {
    const store = createLoadedStore(assets, "room");
    const firstSceneId = store.getSnapshot().activeSceneId!;
    expect(store.createScene("Second scene", "room").ok).toBe(true);
    const secondSceneId = store.getSnapshot().activeSceneId!;
    const placed = store.addObject("vase", [0, 0, 0]);
    if (!placed.ok) throw new Error(placed.error);

    // Populate a case outside scene zero so occupancy follows the same scene as placement
    expect(store.addAttachedObject("vase", placed.object.id, [0, 1, 0]).ok).toBe(true);
    const displayed = store.getSnapshot().objects[1]!;
    expect(store.removeDisplayedAsset(placed.object.id).ok).toBe(true);
    expect(store.getSnapshot().objects.map((object) => object.id)).toEqual([placed.object.id]);

    // Undo restores the same attachment while the first scene remains untouched
    store.undo();
    expect(store.getSnapshot().activeSceneId).toBe(secondSceneId);
    expect(store.getSnapshot().objects[1]).toEqual(displayed);
    expect(store.switchScene(firstSceneId).ok).toBe(true);
    expect(store.getSnapshot().objects).toHaveLength(0);
  });
  it("replaces one slot and restores removal without losing the display case", () => {
    const store = createLoadedStore(
      [...assets, { ...assets[1]!, id: "crate", name: "Crate" }],
      "room",
    );
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
