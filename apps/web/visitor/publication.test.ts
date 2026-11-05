import { expect, it } from "vitest";
import { readPublicationManifest } from "./publication";
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
      url: `/api/publications/${id}/assets/${asset}/bytes`,
    },
  ],
};
it("uses only assets bound to the requested publication", () => {
  expect(readPublicationManifest(value, id).assets[0]?.url).toBe(value.assets[0]?.url);
});
it.each([
  "https://elsewhere.test/asset.glb",
  `/api/assets/${asset}/bytes`,
  `/api/publications/${asset}/assets/${asset}/bytes`,
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
