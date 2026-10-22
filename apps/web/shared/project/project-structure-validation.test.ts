import { describe, expect, it } from "vitest";
import { validateProjectStructure } from "./project-structure-validation";

function sampleProject() {
  // Local fixture so these tests work without the ignored context folders
  const object = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Display stand",
    assetId: "stand-v1",
    transform: { position: [1, 0, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  };
  const scene = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Room",
    environmentAssetId: "room-v1",
    startCamera: { position: [0, 1.6, 5], rotation: [0, 0, 0, 1], fovDegrees: 60 },
    objects: [object],
  };
  const project = {
    schemaVersion: 1,
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Exhibition",
    scenes: [scene],
  };
  return { project, scene, object };
}

describe("M1 project structure", () => {
  it("preserves authored values and object order in a separate copy", () => {
    const { project, scene, object } = sampleProject();
    scene.objects.push({ ...object, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Second" });
    project.title = "  展览  ";
    const result = validateProjectStructure(project);
    expect(result).toEqual({ ok: true, value: project });
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    // Change the source after validation to catch any shared nested references
    object.transform.position[0] = 99;
    scene.startCamera.position[1] = 88;
    scene.objects.reverse();
    expect(result.value.scenes[0]?.objects[0]?.name).toBe("Display stand");
    expect(result.value.scenes[0]?.objects[0]?.transform.position[0]).toBe(1);
    expect(result.value.scenes[0]?.startCamera.position[1]).toBe(1.6);
  });

  it.each([0, 2, "1"])("rejects unsupported or wrongly typed version %j", (schemaVersion) => {
    const { project } = sampleProject();
    expect(validateProjectStructure({ ...project, schemaVersion })).toMatchObject({
      ok: false,
      error: { path: "project.schemaVersion" },
    });
  });

  it("rejects missing fields and non-object project input", () => {
    expect(validateProjectStructure(null)).toMatchObject({ ok: false, error: { path: "project" } });
    expect(validateProjectStructure({})).toMatchObject({
      ok: false,
      error: { path: "project.schemaVersion" },
    });
    expect(validateProjectStructure({ schemaVersion: 1 })).toMatchObject({
      ok: false,
      error: { path: "project.projectId" },
    });
  });

  it.each([0, 21])("rejects a scene count of %s", (count) => {
    const { project, scene } = sampleProject();
    project.scenes = Array.from({ length: count }, () => scene);
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project.scenes" },
    });
  });

  it("accepts an empty scene and 200 objects but rejects 201", () => {
    const { project, scene, object } = sampleProject();
    scene.objects = [];
    expect(validateProjectStructure(project).ok).toBe(true);
    scene.objects = Array.from({ length: 200 }, (_, index) => ({
      ...object,
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
    }));
    expect(validateProjectStructure(project).ok).toBe(true);
    scene.objects.push(object);
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects" },
    });
  });

  it("rejects malformed nested records and string fields with their full paths", () => {
    const { project, scene, object } = sampleProject();
    expect(validateProjectStructure({ ...project, scenes: [null] })).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0]" },
    });
    expect(
      validateProjectStructure({ ...project, scenes: [{ ...scene, objects: {} }] }),
    ).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects" },
    });
    const input = { ...project, scenes: [{ ...scene, objects: [{ ...object, assetId: 123 }] }] };
    expect(validateProjectStructure(input)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects[0].assetId" },
    });
  });

  it("rejects unknown fields at project, scene and object levels", () => {
    const { project, scene, object } = sampleProject();
    expect(validateProjectStructure({ ...project, owner: "admin" })).toMatchObject({
      ok: false,
      error: { path: "project.owner" },
    });
    expect(
      validateProjectStructure({ ...project, scenes: [{ ...scene, rules: [] }] }),
    ).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].rules" },
    });
    const input = { ...project, scenes: [{ ...scene, objects: [{ ...object, visible: true }] }] };
    expect(validateProjectStructure(input)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects[0].visible" },
    });
  });

  it("forwards spatial errors without changing the input", () => {
    const { project, scene, object } = sampleProject();
    object.transform.scale[1] = 0;
    const before = structuredClone(project);
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects[0].transform.scale[1]" },
    });
    expect(project).toEqual(before);
    object.transform.scale[1] = 1;
    scene.startCamera.fovDegrees = 120;
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].startCamera.fovDegrees" },
    });
  });

  it("accepts exactly 5 MiB of compact JSON and rejects one extra byte", () => {
    const { project } = sampleProject();
    project.title = "";
    const overhead = new TextEncoder().encode(JSON.stringify(project)).byteLength;
    // ASCII makes each added character exactly one byte here
    project.title = "a".repeat(5 * 1024 * 1024 - overhead);
    expect(validateProjectStructure(project).ok).toBe(true);
    project.title += "a";
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project" },
    });
  });

  it.each(["展", "\n"])("counts UTF-8 and JSON escaping in the size limit: %j", (text) => {
    const { project } = sampleProject();
    // Both fit the quick character budget but exceed the encoded document limit
    project.title = text.repeat(3 * 1024 * 1024);
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project" },
    });
  });

  it("shares the early text budget across records", () => {
    const { project, scene } = sampleProject();
    project.title = "a".repeat(3 * 1024 * 1024);
    scene.name = "b".repeat(3 * 1024 * 1024);
    expect(validateProjectStructure(project)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].name" },
    });
  });
});
