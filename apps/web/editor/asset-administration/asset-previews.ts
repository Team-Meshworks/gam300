import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { AssetCandidate } from "./asset-administration";

// Only render validated GLBs through the candidate's own administrator-only byte route.
// Pending/invalid uploads remain explicit downloads rather than automatic model loads.
export function assetPreviewSource(asset: AssetCandidate): CatalogueAsset | null {
  if (
    asset.thumbnail ||
    asset.status !== "approved" ||
    (asset.kind !== "model" && asset.kind !== "environment") ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(asset.id) ||
    !asset.sha256 ||
    !/^[0-9a-f]{64}$/i.test(asset.sha256) ||
    asset.inspectionUrl !== `/api/v1/admin/assets/${asset.id}/bytes`
  ) {
    return null;
  }
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    url: asset.inspectionUrl,
    sha256: asset.sha256,
    thumbnail: null,
  };
}

export function assetPreviewKey(asset: CatalogueAsset): string {
  return JSON.stringify([asset.id, asset.sha256, asset.url]);
}
