import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import m2 from "../shared/project/fixtures/m2-project.json";
import manifest from "../shared/project/fixtures/project-format-cases.json";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import type { ContentProject } from "../shared/project/project-content";
import { serializeProject } from "../shared/project/project-serialization";

const kinds = new Map(Object.entries(manifest.assets));
const assets: CatalogueAsset[] = ["test-room-v1", "test-crate-v1"].map((id) => ({
  id,
  name: id,
  kind: id === "test-room-v1" ? "environment" : "model",
  url: `${id}.glb`,
  thumbnail: null,
  sha256: "0".repeat(64),
}));
function setup() {
  // Model loading stays minimal while validation receives the fixture's approved media registry
  const store = createDocumentStore(assets);
  const loaded = store.loadProject(JSON.stringify(m2), kinds);
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  return store;
}

describe("content document preservation in the existing editor", () => {
  it("deletes a referenced scene atomically and restores its references through recovery undo", () => {
    const store = setup();
    const before = store.getSnapshot().project as ContentProject;
    const destination = before.scenes[1]!;
    expect(store.deleteScene(destination.id).ok).toBe(true);
    const after = store.getSnapshot().project as ContentProject;
    expect(after.scenes).toHaveLength(1);
    expect(after.scenes[0]!.objects[0]!.components.some((c) => c.type === "navigationPoint")).toBe(
      false,
    );
    expect(
      after.scenes[0]!.rules.some((rule) =>
        rule.actions.some((action) => action.type === "navigateScene"),
      ),
    ).toBe(false);
    const saved = serializeProject(after, kinds);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw Error(saved.error.message);
    const reopened = createDocumentStore(assets);
    expect(
      reopened.loadProject(
        saved.value,
        kinds,
        JSON.parse(JSON.stringify(store.getRecoveryHistory())),
      ).ok,
    ).toBe(true);
    reopened.undo();
    expect(reopened.getSnapshot().project).toEqual(before);
    reopened.redo();
    expect(reopened.getSnapshot().project).toEqual(after);
  });

  it("removes rules triggered by a deleted navigation point but retains unrelated rules", () => {
    const document = structuredClone(m2);
    const scene = document.scenes[0]!;
    const point = scene.objects[0]!.components.find(
      (component) => component.type === "navigationPoint",
    )!;
    const related = {
      id: crypto.randomUUID(),
      enabled: false,
      trigger: { type: "click", targetId: point.id },
      actions: [{ type: "openLink", url: "https://example.com" }],
    };
    const store = createDocumentStore(assets);
    expect(
      store.loadProject(
        JSON.stringify({
          ...document,
          scenes: [{ ...scene, rules: [...scene.rules, related] }, ...document.scenes.slice(1)],
        }),
        kinds,
      ).ok,
    ).toBe(true);
    const before = store.getSnapshot().project as ContentProject;
    expect(store.deleteScene(document.scenes[1]!.id).ok).toBe(true);
    const rules = (store.getSnapshot().project as ContentProject).scenes[0]!.rules;
    expect(rules.some((rule) => rule.id === related.id)).toBe(false);
    expect(rules.some((rule) => rule.id === scene.rules[0]!.id)).toBe(true);
    store.undo();
    expect(store.getSnapshot().project).toEqual(before);
  });
  it("saves name, transform and all typed content as one reversible edit with stable targets", () => {
    const store = setup();
    const before = store.getSnapshot().project as ContentProject;
    const object = before.scenes[0]!.objects[0]!;
    const components = object.components.map((entry) =>
      entry.type === "text"
        ? {
            ...entry,
            caption: "Updated caption",
            runs: [{ text: "Literal <script>🏺</script>", marks: ["bold" as const] }],
          }
        : entry,
    );
    expect(
      store.editExhibit(object.id, object, {
        name: "Edited exhibit",
        transform: {
          ...object.transform,
          position: [2, 0, 1],
        },
        components,
      }).ok,
    ).toBe(true);
    const after = store.getSnapshot().project as ContentProject;
    expect(after.scenes[0]!.objects[0]!.components.map((entry) => entry.id)).toEqual(
      object.components.map((entry) => entry.id),
    );
    const json = serializeProject(after, kinds);
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error(json.error.message);
    const reopened = createDocumentStore(assets);
    expect(reopened.loadProject(json.value, kinds).ok).toBe(true);
    expect(reopened.getSnapshot().project).toEqual(after);
    store.undo();
    expect(store.getSnapshot().project).toEqual(before);
    store.redo();
    expect(store.getSnapshot().project).toEqual(after);
  });

  it("rejects stale forms, wrong media and deletion of referenced panels without changing history", () => {
    const store = setup();
    const before = store.getSnapshot();
    const object = before.objects[0]! as import("../shared/project/project-content").ContentObject;
    const fields = {
      name: object.name,
      transform: object.transform,
      components: object.components,
    };
    const wrongMedia = object.components.map((entry) =>
      entry.type === "image" ? { ...entry, assetId: "test-crate-v1" } : entry,
    );
    expect(store.editExhibit(object.id, object, { ...fields, components: wrongMedia }).ok).toBe(
      false,
    );
    expect(
      store.editExhibit(object.id, object, {
        ...fields,
        components: object.components.filter((entry) => entry.type !== "text"),
      }).ok,
    ).toBe(false);
    expect(
      store.editExhibit(object.id, object, {
        ...fields,
        transform: { ...object.transform, scale: [0, 1, 1] },
      }).ok,
    ).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    store.renameObject(object.id, "Changed elsewhere");
    const changed = store.getSnapshot();
    expect(store.editExhibit(object.id, object, fields).ok).toBe(false);
    expect(store.getSnapshot()).toBe(changed);
  });

  it("upgrades a released object for content editing and preserves placement undo", () => {
    const store = createDocumentStore(assets);
    expect(store.createProject("test-room-v1").ok).toBe(true);
    const added = store.addObject("test-crate-v1", [0, 0, 0]);
    if (!added.ok) throw new Error(added.error);
    expect(
      store.editExhibit(added.object.id, added.object, {
        name: added.object.name,
        transform: added.object.transform,
        components: [
          {
            id: crypto.randomUUID(),
            type: "text",
            runs: [{ text: "A story", marks: [] }],
            caption: "",
          },
        ],
      }).ok,
    ).toBe(true);
    store.undo();
    expect(
      (store.getSnapshot().objects[0] as import("../shared/project/project-content").ContentObject)
        .components,
    ).toEqual([]);
    store.undo();
    expect(store.getSnapshot().objects).toEqual([]);
    store.redo();
    store.redo();
    expect(serializeProject(store.getSnapshot().project, kinds).ok).toBe(true);
  });
  it("returns New to room selection without carrying objects or undo into the next project", () => {
    const store = setup();
    const id = store.getSnapshot().objects[0]!.id;
    store.setTransform(id, { ...store.getSnapshot().objects[0]!.transform, position: [3, 0, 0] });
    store.copyObject(id);
    store.resetProject();
    expect(store.getSnapshot()).toMatchObject({
      project: null,
      objects: [],
      canUndo: false,
      canRedo: false,
    });
    store.undo();
    expect(store.getSnapshot().project).toBe(null);
    expect(store.getRecoveryHistory()).toBeUndefined();
  });

  it("preserves other scenes, components and rules through transforms, saving and recovered undo", () => {
    const store = setup();
    const original = store.getSnapshot().project as ContentProject;
    const object = original.scenes[0]!.objects[0]!;
    // Edit the visible scene while retaining untouched authored data by identity
    const after = { ...object.transform, position: [2, 1, -3] as const };
    expect(store.setTransform(object.id, after).ok).toBe(true);
    const edited = store.getSnapshot().project as ContentProject;
    expect(edited.scenes).toHaveLength(2);
    expect(edited.scenes[1]).toBe(original.scenes[1]);
    expect(edited.scenes[0]!.rules).toBe(original.scenes[0]!.rules);
    expect(edited.scenes[0]!.objects[0]!.components).toBe(object.components);
    expect(Object.isFrozen(object.components[0])).toBe(true);
    expect(Object.isFrozen(edited.scenes[0]!.rules[0]!.actions)).toBe(true);
    const saved = serializeProject(edited, kinds);
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
    const reopened = createDocumentStore(assets);

    // Exercise recovered commands in a fresh store rather than reusing in-memory undo state
    expect(reopened.loadProject(saved.value, kinds, store.getRecoveryHistory()).ok).toBe(true);
    reopened.undo();
    expect(reopened.getSnapshot().project).toEqual(original);
    const recovered = reopened.getSnapshot().project as ContentProject;
    expect(Object.isFrozen(recovered.scenes[0]!.objects[0]!.components[0])).toBe(true);
    reopened.redo();
    expect(reopened.getSnapshot().project).toEqual(edited);
  });

  it("rejects dangling-reference deletion and unsafe content copying without touching history", () => {
    const store = setup();
    const before = store.getSnapshot();

    // Failed commands must preserve the exact published snapshot as well as undo history
    const id = before.objects[0]!.id;
    expect(store.deleteObject(id).ok).toBe(false);
    expect(store.duplicateObject(id).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.copyObject(id).ok).toBe(true);
    expect(store.pasteObject().ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });

  it("adds valid model objects and restores their exact IDs through undo and redo", () => {
    const store = setup();
    const placed = store.addObject("test-crate-v1", [3, 0, 0]);
    expect(placed.ok).toBe(true);
    if (!placed.ok) {
      throw new Error(placed.error);
    }
    expect(placed.object).toMatchObject({ parentId: null, visible: true, components: [] });
    expect(serializeProject(store.getSnapshot().project, kinds).ok).toBe(true);
    const after = store.getSnapshot().project;
    store.undo();
    expect(store.getSnapshot().objects.some((object) => object.id === placed.object.id)).toBe(
      false,
    );
    store.redo();
    expect(store.getSnapshot().project).toEqual(after);
    expect(store.deleteObject(placed.object.id).ok).toBe(true);
    store.undo();
    expect(store.getSnapshot().project).toEqual(after);
  });

  it("adds at most one hotspot to each content object", () => {
    const store = setup();
    const [first, second] = store.getSnapshot().objects;
    expect(store.addHotspot(first!.id).ok).toBe(false);
    expect(store.addHotspot(second!.id).ok).toBe(true);
    expect(store.addHotspot(second!.id).ok).toBe(false);
    expect(serializeProject(store.getSnapshot().project, kinds).ok).toBe(true);
  });

  it("rejects invalid richer imports and transforms without replacing the open document", () => {
    const store = setup();
    const before = store.getSnapshot();
    const object = before.objects[0]!;
    expect(store.setTransform(object.id, { ...object.transform, scale: [10001, 1, 1] }).ok).toBe(
      false,
    );
    const invalid = structuredClone(m2);
    invalid.scenes[0]!.rules[0]!.actions[0] = { type: "showPanel", panelId: "missing-id" };
    expect(store.loadProject(JSON.stringify(invalid), kinds).ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
});

it("edits the active second scene without overwriting the first or losing media validation", () => {
  const store = setup();
  const original = store.getSnapshot().project as ContentProject;
  const second = original.scenes[1]!;
  expect(store.switchScene(second.id).ok).toBe(true);
  const added = store.addObject("test-crate-v1", [1, 2, 3]);
  expect(added.ok).toBe(true);
  expect(store.getSnapshot().project!.scenes[0]).toBe(original.scenes[0]);
  expect(store.createScene("Third", "test-room-v1").ok).toBe(true);
  const target = createDocumentStore(assets);
  expect(
    target.loadProject(
      JSON.stringify(store.getSnapshot().project),
      kinds,
      store.getRecoveryHistory(),
    ).ok,
  ).toBe(true);
  target.undo();
  target.undo();
  expect(target.getSnapshot().project).toEqual(original);
  expect(target.getSnapshot().activeSceneId).toBe(second.id);
});
it("deletes a referenced viewpoint and restores references on undo", () => {
  const source = structuredClone(m2);
  const destination = source.scenes[0]!;
  const origin = source.scenes[1]!;
  const point = {
    id: crypto.randomUUID(),
    type: "navigationPoint",
    label: "Back",
    sceneId: destination.id,
    viewpointId: destination.viewpoints[0]!.id.toUpperCase(),
  };
  const related = {
    id: crypto.randomUUID(),
    enabled: false,
    trigger: { type: "click", targetId: point.id },
    actions: [{ type: "openLink", url: "https://example.com" }],
  };
  const document = {
    ...source,
    scenes: [
      destination,
      {
        ...origin,
        objects: [{ ...origin.objects[0]!, components: [point] }],
        rules: [...origin.rules, related],
      },
    ],
  };
  const store = createDocumentStore(assets);
  expect(store.loadProject(JSON.stringify(document), kinds).ok).toBe(true);
  const before = store.getSnapshot();
  const project = before.project as ContentProject;
  const referenced = project.scenes[0]!.viewpoints[0]!;
  expect(store.deleteViewpoint(referenced.id).ok).toBe(true);
  const after = store.getSnapshot().project as ContentProject;
  expect(after.scenes[0]!.viewpoints).toEqual([]);
  expect(after.scenes[1]!.objects[0]!.components).toEqual([]);
  expect(after.scenes[1]!.rules.some((rule) => rule.id === related.id)).toBe(false);
  expect(serializeProject(after, kinds).ok).toBe(true);
  const saved = serializeProject(after, kinds);
  if (!saved.ok) throw Error(saved.error.message);
  const recovered = createDocumentStore(assets);
  expect(
    recovered.loadProject(
      saved.value,
      kinds,
      JSON.parse(JSON.stringify(store.getRecoveryHistory())),
    ).ok,
  ).toBe(true);
  recovered.undo();
  expect(recovered.getSnapshot().project).toEqual(before.project);
  recovered.redo();
  expect(recovered.getSnapshot().project).toEqual(after);
});

it("confirms appearance as one reversible edit and preserves it through save and reopen", () => {
  const store = setup();
  const before = store.getSnapshot().project;
  const id = store.getSnapshot().objects[0]!.id;
  expect(store.setAppearance(id, { color: "#bd2949", material: "wood" }).ok).toBe(true);
  const saved = serializeProject(store.getSnapshot().project, kinds);
  if (!saved.ok) throw Error(saved.error.message);
  const target = createDocumentStore(assets);
  expect(target.loadProject(saved.value, kinds).ok).toBe(true);
  expect(
    (target.getSnapshot().objects[0] as ContentProject["scenes"][number]["objects"][number])
      .appearance,
  ).toEqual({ color: "#bd2949", material: "wood" });
  store.undo();
  expect(store.getSnapshot().project).toEqual(before);
  store.redo();
  expect(store.setAppearance(id, { color: "url(x)", material: "wood" }).ok).toBe(false);
});
