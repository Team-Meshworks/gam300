import { expect, it } from "vitest";
import legacy from "./fixtures/m1-project.json";
import content from "./fixtures/m2-project.json";
import corpus from "./fixtures/project-format-cases.json";
import { serializeProject } from "./project-serialization";
import { deserializeProject } from "./project-deserialization";
import { MAX_PROJECT_BYTES } from "./project-limits";

it.each([legacy, content])(
  "keeps released schema $schemaVersion documents valid at the exact wire byte limit",
  (fixture) => {
    const input = JSON.parse(JSON.stringify(fixture));
    // Identity rotations avoid unrelated floating-point normalization drift at the byte boundary.
    const identityRotations = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "rotation" && Array.isArray(child)) child.splice(0, child.length, 0, 0, 0, 1);
        else identityRotations(child);
      }
    };
    identityRotations(input);
    if (input.schemaVersion === 2) {
      // V2 bounds each text panel, so distribute the payload across valid unique components.
      for (let index = 0; index < 80; index++) {
        const suffix = String(index).padStart(12, "0");
        input.scenes[0].objects.push({
          ...structuredClone(input.scenes[0].objects[1]),
          id: "80000000-0000-4000-8000-" + suffix,
          parentId: null,
          components: [
            {
              id: "90000000-0000-4000-8000-" + suffix,
              type: "text",
              caption: "",
              runs: [{ text: "", marks: [] }],
            },
          ],
        });
      }
    }
    const kinds = new Map(Object.entries(corpus.assets));
    const baseline = serializeProject(input, kinds);
    if (!baseline.ok) throw new Error(baseline.error.message);
    const wire = JSON.parse(baseline.value);
    let remaining = MAX_PROJECT_BYTES - new TextEncoder().encode(baseline.value).byteLength;
    if (wire.schemaVersion === 1) wire.title += "x".repeat(remaining);
    else {
      for (const object of wire.scenes[0].objects.slice(-80)) {
        const length = Math.min(65536, remaining);
        object.components[0].runs[0].text = "x".repeat(length);
        remaining -= length;
      }
      expect(remaining).toBe(0);
    }
    const text = JSON.stringify(wire);
    expect(new TextEncoder().encode(text).byteLength).toBe(MAX_PROJECT_BYTES);
    const loaded = deserializeProject(text, kinds);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(serializeProject(loaded.value, kinds)).toEqual({ ok: true, value: text });
    wire.title += "x";
    expect(deserializeProject(JSON.stringify(wire), kinds).ok).toBe(false);
    expect(serializeProject(wire, kinds).ok).toBe(false);
  },
);
