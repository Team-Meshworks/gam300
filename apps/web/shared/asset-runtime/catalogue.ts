// Approved 3D categories are shared by filtering and its consuming picker
export const assetCategories = [
  "All",
  "Objects",
  "Furniture",
  "Architecture",
  "Clothing",
  "Tools & Equipment",
] as const;

export type CatalogueAsset = Readonly<{
  id: string;
  name: string;
  kind: "environment" | "model";
  url: string;
  sha256: string;
  thumbnail: string | null;
  placement?: "bottom-center";
  category?: string;
}>;

export const assetDragType = "application/x-vthere-asset";

// Keep the catalogue order and asset IDs used by placement
// Match literal text so search never evaluates user-supplied patterns
export function searchAssets(
  assets: readonly CatalogueAsset[],
  query: string,
  category: string = "All",
) {
  const name = query.trim().toLowerCase();
  // Apply name and category together while preserving asset identity and catalogue order
  return assets.filter(
    (asset) =>
      (category === "All" || asset.category === category) &&
      asset.name.toLowerCase().includes(name),
  );
}
