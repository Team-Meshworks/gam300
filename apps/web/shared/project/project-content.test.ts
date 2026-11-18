import { describe, expect, it } from "vitest";
import m1 from "./fixtures/m1-project.json";
import m2 from "./fixtures/m2-project.json";
import manifest from "./fixtures/project-format-cases.json";
import { deserializeProject } from "./project-deserialization";
import { serializeProject } from "./project-serialization";
import { validateProjectStructure } from "./project-structure-validation";
import { missingProjectCapabilities } from "./project-capabilities";
import type { ContentProject } from "./project-content";
import { readField } from "./validation-helpers";

type FormatCase = {
  name: string;
  base: "m1" | "m2";
  valid: boolean;
  path?: string;
  patches: { path: (string | number)[]; value: unknown; remove?: boolean; repeat?: number }[];
};
const assets = new Map(Object.entries(manifest.assets));

// Keep acceptance cases shared with C# rather than maintaining two competing contracts
const cases = manifest.cases as FormatCase[];

describe("shared browser/server project-format fixtures", () => {
  it("round-trips an empty project without requiring an approved environment", () => {
    const scene = m2.scenes[0]!;
    const input = {
      ...m2,
      scenes: [
        {
          ...scene,
          environmentAssetId: null,
          objects: [],
          groups: [],
          zones: [],
          viewpoints: [],
          rules: [],
          hotspots: [],
          interactions: [],
          audio: [],
        },
      ],
    };
    const saved = serializeProject(input, new Map());
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(deserializeProject(saved.value, new Map())).toEqual({ ok: true, value: input });
  });

  it("reads required and optional scene fields only from the authored object", () => {
    const input = structuredClone(m2);
    const scene = input.scenes[0]!;
    Object.setPrototypeOf(scene, { id: scene.id, environmentVisible: false });
    const parsed = validateProjectStructure(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.scenes[0]).not.toHaveProperty("environmentVisible");

    const withoutId: Partial<typeof scene> = scene;
    delete withoutId.id;
    expect(validateProjectStructure(input)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].id", message: "Required field is missing" },
    });
  });

  it.each(manifest.rawCases)("raw JSON: $name", (test) => {
    const result = deserializeProject(test.json, assets);
    expect(result.ok).toBe(test.valid);
    if (!result.ok) {
      expect(result.error.path).toBe(test.path);
    }
  });
  it.each(cases)("$name", (test) => {
    const input = structuredClone(test.base === "m1" ? m1 : m2);

    // Change only this case's fixture so failures cannot alter later inputs
    for (const patch of test.patches) {
      let parent: unknown = input;
      for (const segment of patch.path.slice(0, -1)) {
        if (typeof parent !== "object" || parent === null)
          throw new Error("Missing fixture parent");
        parent = readField(parent, segment);
      }
      const key = patch.path.at(-1);
      if (typeof parent !== "object" || parent === null || key === undefined) {
        throw new Error("Invalid fixture patch");
      }
      if (patch.remove) {
        Reflect.deleteProperty(parent, key);
      } else {
        // Build large boundary inputs at runtime to keep the shared fixture compact
        const value =
          patch.repeat === undefined
            ? patch.value
            : typeof patch.value === "string"
              ? patch.value.repeat(patch.repeat)
              : Array.from({ length: patch.repeat }, () => structuredClone(patch.value));
        Object.defineProperty(parent, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    const result = deserializeProject(JSON.stringify(input), assets);
    expect(result.ok).toBe(test.valid);
    if (!result.ok) {
      expect(result.error.path).toBe(test.path);
    } else {
      const saved = serializeProject(result.value, assets);
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(deserializeProject(saved.value, assets)).toEqual(result);
      }
    }
  });

  it("preserves authored content, parentage and ordering", () => {
    expect(deserializeProject(JSON.stringify(m2), assets)).toEqual({ ok: true, value: m2 });
  });

  it("retains known unsupported rules and reports capabilities before execution", () => {
    const result = deserializeProject(JSON.stringify(m2), assets);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const project = result.value as ContentProject;
    const issues = missingProjectCapabilities(project, new Set());
    expect(issues).toContainEqual({ path: "project.scenes", capability: "multipleScenes" });
    expect(issues).toContainEqual({
      path: "project.scenes[0].rules[4].trigger",
      capability: "trigger:gaze",
    });
    const supported = new Set(issues.map((issue) => issue.capability));
    expect(missingProjectCapabilities(project, supported)).toEqual([]);
    supported.delete("trigger:gaze");
    const disabled = structuredClone(project);

    // Authoring and saving retain the rule even while a player cannot run it
    const edited = {
      ...disabled,
      scenes: disabled.scenes.map((scene) => ({
        ...scene,
        rules: scene.rules.map((rule) => ({
          ...rule,
          enabled: rule.trigger.type === "gaze" ? false : rule.enabled,
        })),
      })),
    };
    expect(missingProjectCapabilities(edited, supported)).toEqual([]);
    const saved = serializeProject(edited, assets);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.value).toContain('"type":"gaze"');
    }
  });
});
