import { describe, expect, it } from "vitest";
import fixture from "./fixtures/m1-project.json";
import { serializeProject } from "./project-serialization";
import { validateProject } from "./project-validation";

const assets = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);

describe("project JSON serialization", () => {
  it("preserves IDs, object order and numeric precision over two encodings", () => {
    const first = serializeProject(fixture, assets);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);

    // Read the JSON back through the validator to check both sides of the format
    // The file reader will add checks around parsing in the next phase
    const decoded: unknown = JSON.parse(first.value);
    const restored = validateProject(decoded, assets);
    expect(restored).toEqual({ ok: true, value: fixture });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(serializeProject(restored.value, assets)).toEqual(first);
  });

  it("preserves names with quotes, line breaks and Unicode text", () => {
    const input = { ...fixture, title: '展览 "Crates"\nRoom \\ A' };
    const result = serializeProject(input, assets);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.parse(result.value)).toEqual(input);
  });

  it("rejects invalid project data with its original field error", () => {
    const input = structuredClone(fixture);
    const object = input.scenes[0]?.objects[0];
    if (!object) throw new Error("Fixture needs a placed object");
    object.transform.position[0] = Infinity;
    expect(serializeProject(input, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].objects[0].transform.position" },
    });
    expect(serializeProject(fixture, new Map())).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].environmentAssetId" },
    });
    expect(serializeProject({ ...fixture, undoHistory: [] }, assets)).toMatchObject({
      ok: false,
      error: { path: "project.undoHistory" },
    });
  });

  it("normalizes small rotation drift in the saved copy without changing the source", () => {
    const input = structuredClone(fixture);
    const object = input.scenes[0]?.objects[0];
    if (!object) throw new Error("Fixture needs a placed object");
    object.transform.rotation = [0, 0, 0, 1.0000001];
    const before = structuredClone(input);
    const result = serializeProject(input, assets);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const expected = structuredClone(input);
    const savedObject = expected.scenes[0]?.objects[0];
    if (!savedObject) throw new Error("Fixture needs a placed object");
    savedObject.transform.rotation = [0, 0, 0, 1];
    expect(JSON.parse(result.value)).toEqual(expected);
    expect(input).toEqual(before);
  });
});
