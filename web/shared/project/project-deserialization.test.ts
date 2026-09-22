import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/m1-project.json";
import { deserializeProject } from "./project-deserialization";

const assets = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);

describe("project JSON reader", () => {
  it("reads indented JSON with escaped quotes, backslashes and brackets in names", () => {
    const input = { ...fixture, title: 'Room "A" \\ ' + "[{".repeat(40) + "展览\n" };
    expect(deserializeProject(JSON.stringify(input, null, 2), assets)).toEqual({
      ok: true,
      value: input,
    });
  });

  it.each(["", '{"title":', '{"title":"private text",}', "]["])(
    "returns a safe syntax error for malformed JSON %j",
    (text) => {
      expect(deserializeProject(text, assets)).toEqual({
        ok: false,
        error: { path: "project", message: "Project JSON is malformed" },
      });
    },
  );

  it("rejects non-text input and valid JSON with the wrong project structure", () => {
    expect(deserializeProject(fixture, assets).ok).toBe(false);
    expect(deserializeProject("null", assets)).toMatchObject({
      ok: false,
      error: { path: "project" },
    });
    expect(deserializeProject('{"schemaVersion":99}', assets)).toMatchObject({
      ok: false,
      error: { path: "project.schemaVersion" },
    });
  });

  it("accepts exactly 5 MiB of text and rejects one extra whitespace byte", () => {
    const text = JSON.stringify(fixture);
    const padded = text.padEnd(5 * 1024 * 1024, " ");
    expect(deserializeProject(padded, assets).ok).toBe(true);
    expect(deserializeProject(padded + " ", assets)).toMatchObject({
      ok: false,
      error: { message: "Project JSON exceeds the 5 MiB file limit" },
    });
  });

  it("counts UTF-8 bytes before parsing", () => {
    const text = JSON.stringify({ ...fixture, title: "展".repeat(2 * 1024 * 1024) });
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(deserializeProject(text, assets)).toMatchObject({
        ok: false,
        error: { message: "Project JSON exceeds the 5 MiB file limit" },
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("allows depth 32 through to validation and rejects depth 33 before parsing", () => {
    // Nested arrays isolate the reader's depth limit from the project schema
    const atLimit = "[".repeat(32) + "0" + "]".repeat(32);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(deserializeProject(atLimit, assets)).toMatchObject({
        ok: false,
        error: { message: "Project must be an object" },
      });
      expect(parse).toHaveBeenCalledOnce();
      parse.mockClear();
      expect(deserializeProject("[" + atLimit + "]", assets)).toMatchObject({
        ok: false,
        error: { message: "Project JSON exceeds the nesting limit of 32" },
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("forwards reference and numeric errors from parsed data", () => {
    expect(deserializeProject(JSON.stringify(fixture), new Map())).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].environmentAssetId" },
    });
    const text = JSON.stringify(fixture).replace(/"fovDegrees":\d+/, '"fovDegrees":1e400');
    expect(deserializeProject(text, assets)).toMatchObject({
      ok: false,
      error: { path: "project.scenes[0].startCamera.fovDegrees" },
    });
  });
});
