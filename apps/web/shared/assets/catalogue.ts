export type CatalogueAsset = Readonly<{
  id: string;
  name: string;
  kind: "environment" | "model";
  url: string;
  sha256: string;
  thumbnail: string | null;
  placement?: "bottom-center";
}>;

export const assetDragType = "application/x-vthere-asset";

// Keep the catalogue order and asset IDs used by placement
// Match literal text so search never evaluates user-supplied patterns
export function searchAssets(assets: readonly CatalogueAsset[], query: string) {
  const name = query.trim().toLowerCase();
  return assets.filter((asset) => asset.name.toLowerCase().includes(name));
}
