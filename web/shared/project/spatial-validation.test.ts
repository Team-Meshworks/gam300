import { describe, expect, it } from "vitest";
import { validateCameraPose, validateTransform } from "./spatial-validation";

// Fresh arrays for each test so one case can't change the next case's starting data
function sampleTransform() {
  return { position: [1, 0, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function sampleCamera() {
  return { position: [0, 1.6, 5], rotation: [0, 0, 0, 1], fovDegrees: 60 };
}

describe("transform validation", () => {
  it("accepts a transform without changing its position or scale", () => {
    const input = { ...sampleTransform(), position: [1.123456789, -2, 3], scale: [0.5, 2, 3] };
    expect(validateTransform(input)).toEqual({ ok: true, value: input });
  });

  it.each([null, undefined, [], "transform", 1])("rejects a non-object input: %j", (input) => {
    expect(validateTransform(input)).toMatchObject({ ok: false, error: { path: "transform" } });
  });

  // Each row replaces one field in an otherwise valid transform
  it.each([
    ["position", [0, 0]],
    ["position", [0, 0, 0, 0]],
    ["position", ["1", 0, 0]],
    ["position", [0, NaN, 0]],
    ["position", [0, 0, Infinity]],
    ["position", Array(3)],
    ["rotation", [0, 0, 1]],
    ["rotation", [0, 0, 0, 1, 0]],
    ["rotation", [0, 0, 0, "1"]],
    ["rotation", [0, 0, NaN, 1]],
    ["rotation", [0, 0, 0, 0]],
    ["rotation", [0, 0, 0, 2]],
    ["rotation", [0, 0, 0, 1.000002]],
    ["rotation", [Number.MAX_VALUE, Number.MAX_VALUE, 0, 0]],
    ["scale", [1, 1]],
    ["scale", [1, 1, 1, 1]],
    ["scale", [1, null, 1]],
    ["scale", [1, -Infinity, 1]],
  ])("rejects invalid %s data: %j", (field, value) => {
    expect(validateTransform({ ...sampleTransform(), [field]: value })).toMatchObject({
      ok: false,
      error: { path: `transform.${field}` },
    });
  });

  it.each([0, -0, -1])("rejects non-positive scale %s with an axis path", (scale) => {
    expect(validateTransform({ ...sampleTransform(), scale: [1, scale, 1] })).toMatchObject({
      ok: false,
      error: { path: "transform.scale[1]" },
    });
  });

  it("accepts both position limits", () => {
    expect(validateTransform({ ...sampleTransform(), position: [-10_000, 0, 10_000] }).ok).toBe(
      true,
    );
  });

  it.each([-10_000.001, 10_000.001])("rejects position outside the limit: %s", (position) => {
    expect(validateTransform({ ...sampleTransform(), position: [position, 0, 0] })).toMatchObject({
      ok: false,
      error: { path: "transform.position[0]" },
    });
  });

  it("normalizes small quaternion drift without modifying or sharing the input arrays", () => {
    const input = { ...sampleTransform(), rotation: [0, 0, 0, 1.0000005] };
    // Keep the original values for comparison after normalization
    const before = structuredClone(input);
    const result = validateTransform(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.rotation).toEqual([0, 0, 0, 1]);
    // Equal values can still share an array; check the references as well
    expect(result.value.position).not.toBe(input.position);
    expect(result.value.rotation).not.toBe(input.rotation);
    expect(result.value.scale).not.toBe(input.scale);
    expect(input).toEqual(before);
  });

  it.each([1, -1])("preserves quaternion orientation with sign %s", (sign) => {
    // q and -q describe the same rotation
    // Normalizing should preserve whichever sign came from the file
    const rotation = [0, Math.SQRT1_2 * sign, 0, Math.SQRT1_2 * sign];
    const result = validateTransform({ ...sampleTransform(), rotation });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.rotation[1]).toBeCloseTo(Math.SQRT1_2 * sign, 12);
    expect(result.value.rotation[3]).toBeCloseTo(Math.SQRT1_2 * sign, 12);
  });

  it("reports a missing field at its full project path", () => {
    const input = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
    expect(validateTransform(input, "scenes[0].objects[2].transform")).toMatchObject({
      ok: false,
      error: { path: "scenes[0].objects[2].transform.scale" },
    });
  });

  it("rejects an unknown field without modifying the input", () => {
    const input = { ...sampleTransform(), matrix: [] };
    const before = structuredClone(input);
    expect(validateTransform(input)).toMatchObject({
      ok: false,
      error: { path: "transform.matrix" },
    });
    expect(input).toEqual(before);
  });
});

describe("camera validation", () => {
  it.each([30, 60, 90])("accepts field of view %s", (fovDegrees) => {
    const input = { ...sampleCamera(), fovDegrees };
    expect(validateCameraPose(input)).toEqual({ ok: true, value: input });
  });

  it.each([29.999, 90.001, NaN, Infinity, "60", null, undefined])(
    "rejects invalid field of view: %j",
    (fovDegrees) => {
      expect(validateCameraPose({ ...sampleCamera(), fovDegrees })).toMatchObject({
        ok: false,
        error: { path: "startCamera.fovDegrees" },
      });
    },
  );

  it.each([null, [], "camera"])("rejects non-object camera input: %j", (input) => {
    expect(validateCameraPose(input).ok).toBe(false);
  });

  it("checks camera position and rotation through the same spatial rules", () => {
    expect(validateCameraPose({ ...sampleCamera(), position: [0, 10_001, 0] })).toMatchObject({
      ok: false,
      error: { path: "startCamera.position[1]" },
    });
    expect(validateCameraPose({ ...sampleCamera(), rotation: [0, 0, 0, 0] })).toMatchObject({
      ok: false,
      error: { path: "startCamera.rotation" },
    });
  });

  it("rejects missing and unknown camera fields", () => {
    expect(validateCameraPose({ position: [0, 0, 0], rotation: [0, 0, 0, 1] })).toMatchObject({
      ok: false,
      error: { path: "startCamera.fovDegrees" },
    });
    expect(validateCameraPose({ ...sampleCamera(), zoom: 2 })).toMatchObject({
      ok: false,
      error: { path: "startCamera.zoom" },
    });
  });

  it("returns a separate camera copy after normalizing small rotation drift", () => {
    const input = { ...sampleCamera(), rotation: [0, 0, 0, 0.9999995] };
    const before = structuredClone(input);
    const result = validateCameraPose(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.rotation).toEqual([0, 0, 0, 1]);
    expect(result.value.position).not.toBe(input.position);
    expect(result.value.rotation).not.toBe(input.rotation);
    expect(input).toEqual(before);
  });
});
