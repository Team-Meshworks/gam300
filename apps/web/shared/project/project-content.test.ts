import { describe, expect, it } from "vitest";
import m1 from "./fixtures/m1-project.json";
import m2 from "./fixtures/m2-project.json";
import manifest from "./fixtures/project-format-cases.json";
import { deserializeProject } from "./project-deserialization";
import { serializeProject } from "./project-serialization";
import { missingProjectCapabilities } from "./project-capabilities";
import type { ContentProject } from "./project-content";

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
  it.each(manifest.rawCases)("raw JSON: $name", (test) => {
    const result = deserializeProject(test.json, assets);
    expect(result.ok).toBe(test.valid);
    if (!result.ok) {
      expect(result.error.path).toBe(test.path);
    }
  });
  it.each(cases)("$name", (test) => {
    const input: unknown = structuredClone(test.base === "m1" ? m1 : m2);

    // Change only this case's fixture so failures cannot alter later inputs
    for (const patch of test.patches) {
      let parent = input as Record<string, unknown>;
      for (const segment of patch.path.slice(0, -1)) {
        parent = parent[String(segment)] as Record<string, unknown>;
      }
      const key = String(patch.path.at(-1));
      if (patch.remove) {
        delete parent[key];
      } else {
        // Build large boundary inputs at runtime to keep the shared fixture compact
        parent[key] =
          patch.repeat === undefined
            ? patch.value
            : typeof patch.value === "string"
              ? patch.value.repeat(patch.repeat)
              : Array.from({ length: patch.repeat }, () => structuredClone(patch.value));
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

  it("preserves all authored content, parentage and ordering in a separate copy", () => {
    const source = structuredClone(m2);
    const result = deserializeProject(JSON.stringify(source), assets);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const project = result.value as ContentProject;
    const first = project.scenes[0]!;
    expect(project.scenes.map((scene) => scene.id)).toEqual(source.scenes.map((scene) => scene.id));
    expect(first.rules).toEqual(source.scenes[0]!.rules);
    expect(first.objects[0]!.components).toEqual(source.scenes[0]!.objects[0]!.components);
    expect(first.objects[1]!.parentId).toBe(first.objects[0]!.id);
    source.scenes.reverse();
    source.scenes[1]!.rules.reverse();
    expect(first.rules[0]!.trigger.type).toBe("click");
    expect(project.scenes[0]!.name).toBe("Room");
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
