import { describe, expect, it } from "vitest";
import { validateProject } from "./project-validation";

function sampleProject() {
  const object = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Crate",
    assetId: "test-crate-v1",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  };
  const scene = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Room",
    environmentAssetId: "test-room-v1",
    startCamera: { position: [0, 1.6, 5], rotation: [0, 0, 0, 1], fovDegrees: 60 },
    objects: [object],
    hotspots: [] as { id: string; objectId: string; position: [number, number, number] }[],
    interactions: [] as { when: unknown; do: unknown }[],
  };
  const project = {
    schemaVersion: 1,
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Exhibition",
    scenes: [scene],
  };
  // Same ID and kind fields as the draft asset catalog
  // Tests only need these entries; no model downloads or private file paths
  const assets = new Map([
    ["test-room-v1", "environment"],
    ["test-crate-v1", "model"],
  ]);
  return { project, scene, object, assets };
}

describe("project IDs and asset references", () => {
  it("rejects a trailing newline on a UUID", () => {
    const { project, assets } = sampleProject();
    project.projectId += "\n";
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.projectId" },
    });
  });

  it("accepts shared model assets and preserves uppercase UUID spelling", () => {
    const { project, scene, object, assets } = sampleProject();
    object.id = object.id.toUpperCase();
    scene.objects.push({ ...object, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    const before = structuredClone(project);
    const registryBefore = new Map(assets);
    const result = validateProject(project, assets);
    expect(result).toEqual({ ok: true, value: before });
    expect(project).toEqual(before);
    expect(assets).toEqual(registryBefore);
    if (result.ok) {
      object.transform.position[0] = 99;
      expect(result.value.scenes[0]?.objects[0]?.transform.position[0]).toBe(0);
    }
  });

  it.each(["project", "scene", "object"])("rejects malformed %s UUIDs at their field", (level) => {
    const { project, scene, object, assets } = sampleProject();
    const paths = {
      project: "project.projectId",
      scene: "project.scenes[0].id",
      object: "project.scenes[0].objects[0].id",
    };
    // Whitespace, missing separators and non-hex letters all need rejection
    if (level === "project") project.projectId = ` ${project.projectId}`;
    if (level === "scene") scene.id = scene.id.replaceAll("-", "");
    if (level === "object") object.id = "gggggggg-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: paths[level as keyof typeof paths] },
    });
  });

  it.each(["project-scene", "project-object", "scene-object", "object-object"])(
    "rejects duplicate IDs across %s, including letter-case changes",
    (pair) => {
      const { project, scene, object, assets } = sampleProject();
      let path = "project.scenes[0].objects[0].id";
      let firstPath = "project.projectId";
      if (pair === "project-scene") {
        scene.id = project.projectId.toUpperCase();
        path = "project.scenes[0].id";
      } else if (pair === "project-object") {
        object.id = project.projectId.toUpperCase();
      } else if (pair === "scene-object") {
        object.id = scene.id.toUpperCase();
        firstPath = "project.scenes[0].id";
      } else {
        scene.objects.push({ ...object, id: object.id.toUpperCase() });
        firstPath = path;
        path = "project.scenes[0].objects[1].id";
      }
      expect(validateProject(project, assets)).toEqual({
        ok: false,
        error: { path, message: `ID already used at ${firstPath}` },
      });
    },
  );

  it.each(["environment", "model"])(
    "rejects missing %s references without editing input",
    (kind) => {
      const { project, scene, object, assets } = sampleProject();
      const environment = kind === "environment";
      assets.delete(environment ? scene.environmentAssetId : object.assetId);
      const before = structuredClone(project);
      const registryBefore = new Map(assets);
      expect(validateProject(project, assets)).toMatchObject({
        ok: false,
        error: {
          path: environment
            ? "project.scenes[0].environmentAssetId"
            : "project.scenes[0].objects[0].assetId",
        },
      });
      expect(project).toEqual(before);
      expect(assets).toEqual(registryBefore);
    },
  );

  it.each(["environment", "model"])("rejects a wrong kind for the %s reference", (kind) => {
    const { project, scene, object, assets } = sampleProject();
    const environment = kind === "environment";
    if (environment) scene.environmentAssetId = object.assetId;
    else object.assetId = scene.environmentAssetId;
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { message: `Expected an asset of kind ${kind}` },
    });
  });

  it("keeps asset lookup case-sensitive and rejects unsupported catalog kinds", () => {
    const { project, object, assets } = sampleProject();
    object.assetId = "TEST-CRATE-V1";
    expect(validateProject(project, assets).ok).toBe(false);
    object.assetId = "test-crate-v1";
    assets.set(object.assetId, "audio");
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects[0].assetId" },
    });
  });

  it("still checks the environment when there are no placed objects", () => {
    const { project, scene, assets } = sampleProject();
    scene.objects = [];
    expect(validateProject(project, assets).ok).toBe(true);
    assets.clear();
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].environmentAssetId" },
    });
  });

  it("rejects hotspot IDs, attachment references and dangling click rules", () => {
    const { project, scene, object, assets } = sampleProject();
    scene.hotspots.push({
      id: object.id,
      objectId: object.id,
      position: [0, 0, 0],
    });
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].hotspots[0].id" },
    });

    scene.hotspots = [
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", objectId: object.id, position: [0, 0, 0] },
    ];
    scene.hotspots[0]!.objectId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].hotspots[0].objectId" },
    });

    scene.hotspots[0]!.objectId = object.id;
    scene.interactions = [
      {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: "missing" },
        do: { type: "print-hi" },
      },
    ];
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].interactions[0].when.targetHotspotId" },
    });
  });

  it("allows only one hotspot per object, comparing UUID case-insensitively", () => {
    const { project, scene, object, assets } = sampleProject();
    scene.hotspots = [
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", objectId: object.id, position: [0, 0, 0] },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        objectId: object.id.toUpperCase(),
        position: [0, 0, 0],
      },
    ];

    expect(validateProject(project, assets)).toEqual({
      ok: false,
      error: {
        path: "project.scenes[0].hotspots[1].objectId",
        message: "Each object can have at most one hotspot",
      },
    });
  });

  it("runs the existing structure and spatial checks before checking references", () => {
    const { project, object, assets } = sampleProject();
    expect(validateProject(null, assets)).toMatchObject({ ok: false, error: { path: "project" } });
    object.transform.scale[0] = 0;
    expect(validateProject(project, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects[0].transform.scale[0]" },
    });
  });
});
