import { afterEach, expect, it, vi } from "vitest";
import { validateProject } from "../shared/project/project-validation";
import { loadPublication, readPublicationManifest } from "./publication";
const id = "11111111-1111-4111-8111-111111111111";
const asset = "22222222-2222-4222-8222-222222222222";
const value = {
  publicationId: id,
  projectId: id,
  sourceRevision: 3,
  assets: [
    {
      id: asset,
      kind: "model",
      sha256: "a".repeat(64),
      url: `/api/v1/publications/${id}/assets/${asset}/bytes`,
    },
  ],
};
it("uses only assets bound to the requested publication", () => {
  expect(readPublicationManifest(value, id).assets[0]?.url).toBe(value.assets[0]?.url);
});
it.each([
  "https://elsewhere.test/asset.glb",
  `/api/v1/assets/${asset}/bytes`,
  `/api/v1/publications/${asset}/assets/${asset}/bytes`,
])("rejects an unrelated asset URL", (url) => {
  expect(() =>
    readPublicationManifest({ ...value, assets: [{ ...value.assets[0], url }] }, id),
  ).toThrow();
});
it("rejects mismatched editions and duplicate asset identities", () => {
  expect(() => readPublicationManifest(value, asset)).toThrow();
  expect(() =>
    readPublicationManifest({ ...value, assets: [value.assets[0], value.assets[0]] }, id),
  ).toThrow();
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  [
    "moved",
    { environmentTransform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ],
  [
    "rotated",
    { environmentTransform: { position: [0, 0, 0], rotation: [0, 1, 0, 0], scale: [1, 1, 1] } },
  ],
  ["hidden", { environmentVisible: false }],
])("rejects a %s initial room instead of silently showing it at the origin", async (_, state) => {
  const scene = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Room",
    environmentAssetId: asset,
    startCamera: { position: [0, 1, 0], rotation: [0, 0, 0, 1], fovDegrees: 40 },
    objects: [],
    ...state,
  };
  const v1 = { schemaVersion: 1, projectId: id, title: "Room", scenes: [scene] };
  const v2 = {
    ...v1,
    schemaVersion: 2,
    scenes: [{ ...scene, groups: [], zones: [], viewpoints: [], rules: [] }],
  };
  expect(validateProject(v2, new Map([[asset, "environment"]])).ok).toBe(true);
  const manifest = { ...value, assets: [{ ...value.assets[0]!, kind: "environment" }] };
  for (const snapshot of [v1, v2]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.endsWith("/manifest") ? manifest : snapshot)),
      ),
    );
    await expect(loadPublication(id, new AbortController().signal)).rejects.toThrow(
      "This exhibition format is not supported.",
    );
  }
});
