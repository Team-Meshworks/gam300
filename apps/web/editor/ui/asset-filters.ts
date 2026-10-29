import type { CatalogueAsset } from "../../shared/assets/catalogue";

// "all", "favourites", or "category:Pottery" for one category
export type AssetFilter = string;

const storageKey = "spatia-favourite-assets";

// Catalogue dont pass the manifest category through yet, so read it only if its there
export function categoryOf(asset: CatalogueAsset): string | undefined {
  return "category" in asset && typeof asset.category === "string" ? asset.category : undefined;
}

export function filterOptions(
  assets: readonly CatalogueAsset[],
): { value: string; label: string }[] {
  const categories = [...new Set(assets.map(categoryOf).filter((name) => name !== undefined))];
  return [
    { value: "all", label: "All assets" },
    { value: "favourites", label: "Favourites" },
    ...categories.sort().map((name) => ({ value: `category:${name}`, label: name })),
  ];
}

export function filterAssets(
  assets: readonly CatalogueAsset[],
  filter: AssetFilter,
  favourites: readonly string[],
): CatalogueAsset[] {
  if (filter === "favourites") return assets.filter((asset) => favourites.includes(asset.id));
  if (filter.startsWith("category:")) {
    const name = filter.slice("category:".length);
    return assets.filter((asset) => categoryOf(asset) === name);
  }
  return [...assets];
}

export function toggleFavourite(favourites: readonly string[], id: string): string[] {
  return favourites.includes(id) ? favourites.filter((other) => other !== id) : [...favourites, id];
}

// Storage can be blocked or hold junk, then just start with no favourites
export function loadFavourites(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveFavourites(favourites: readonly string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(favourites));
  } catch {
    // Nothing to do, the hearts still work for this visit
  }
}
