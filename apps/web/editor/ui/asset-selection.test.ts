import { expect, it } from "vitest";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { belongsInAssetPicker } from "./asset-selection";

it("keeps every room companion out of the general asset library", () => {
  const asset = (id: string, kind: CatalogueAsset["kind"], sha256: string): CatalogueAsset => ({
    id,
    kind,
    name: id,
    sha256,
    url: "",
    thumbnail: null,
  });
  const environment = {
    ...asset("gallery", "environment", "a".repeat(64)),
    boundsMeters: { min: [0, 0, 0] as const, max: [10, 3, 10] as const },
  };
  const companion = asset("approved-room-model", "model", environment.sha256);
  const namedRoom = asset("room-doors-1-module-v1", "model", "b".repeat(64));
  const vase = asset("vase", "model", "c".repeat(64));
  const catalogue = [environment, companion, namedRoom, vase];
  expect(catalogue.filter((entry) => belongsInAssetPicker(entry, true, catalogue))).toEqual([
    environment,
  ]);
  expect(catalogue.filter((entry) => belongsInAssetPicker(entry, false, catalogue))).toEqual([
    vase,
  ]);
});
