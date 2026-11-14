import { expect, it } from "vitest";
import type { AssetCandidate } from "./asset-administration";
import { assetPreviewKey, assetPreviewSource } from "./asset-previews";

const id = "11111111-1111-4111-8111-111111111111";
const candidate: AssetCandidate = {
  id,
  name: "Approved crate",
  kind: "model",
  category: "Objects",
  status: "approved",
  hidden: false,
  deleted: false,
  removedFromProjects: false,
  thumbnail: null,
  inspectionUrl: `/api/v1/admin/assets/${id}/bytes`,
  sha256: "a".repeat(64),
  validation: [],
  actions: ["hide", "delete"],
};

it.each(["model", "environment"] as const)(
  "uses the real admin byte route for an approved %s with no thumbnail",
  (kind) => {
    expect(assetPreviewSource({ ...candidate, kind })).toEqual({
      id,
      name: candidate.name,
      kind,
      url: candidate.inspectionUrl,
      sha256: candidate.sha256,
      thumbnail: null,
    });
  },
);

const unsupported: Partial<AssetCandidate>[] = [
  { status: "pending" },
  { status: "invalid" },
  { status: "unavailable" },
  { kind: "image" },
  { thumbnail: "/existing-preview.png" },
  { inspectionUrl: null },
  { inspectionUrl: `https://outside.invalid/api/v1/admin/assets/${id}/bytes` },
  { inspectionUrl: `/api/v1/assets/${id}/bytes` },
  { inspectionUrl: `/api/v1/admin/assets/22222222-2222-4222-8222-222222222222/bytes` },
  { id: "../other" },
  { sha256: "" },
  { sha256: "invalid" },
];
it.each(unsupported)("does not automatically load unsupported preview metadata: %j", (change) => {
  expect(assetPreviewSource({ ...candidate, ...change })).toBeNull();
});

it("retains previews across visibility changes while version and route changes use new keys", () => {
  const source = assetPreviewSource(candidate)!;
  expect(assetPreviewSource({ ...candidate, hidden: true, deleted: true })).toEqual(source);
  expect(assetPreviewKey(source)).not.toBe(assetPreviewKey({ ...source, sha256: "b".repeat(64) }));
  expect(assetPreviewKey(source)).not.toBe(assetPreviewKey({ ...source, url: "/other" }));
});
