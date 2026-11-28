import {
  assetCategories,
  catalogueTags,
  searchAssets,
  type CatalogueAsset,
} from "../../shared/asset-runtime/catalogue";

// Keep browsing keys separate from asset IDs and authored project data
export type AssetFilter = string;

const storageKey = "spatia-favourite-assets";

// Use delivered catalogue tags without guessing a category from the asset name
export function categoryOf(asset: CatalogueAsset): string | undefined {
  return "category" in asset && typeof asset.category === "string" ? asset.category : undefined;
}

export function filterOptions(
  assets: readonly CatalogueAsset[],
): { value: string; label: string; disabled?: boolean }[] {
  // Keep the agreed order stable and disable empty categories instead of leading authors to a dead end
  const categories = assetCategories.slice(1);
  // Derive availability from the whole catalogue so typing a query never reshuffles the menu
  return [
    { value: "all", label: "Filters" },
    { value: "favourites", label: "Favourites" },
    ...categories.map((name) => ({
      value: `category:${name}`,
      label: name,
      disabled: !assets.some((asset) => categoryOf(asset) === name),
    })),
  ];
}

// Tags have their own menu beside the filters; they come from the assets, so new tags appear as soon as something uses them
export function tagOptions(assets: readonly CatalogueAsset[]): { value: string; label: string }[] {
  return [
    { value: "all", label: "Tags" },
    ...catalogueTags(assets).map((tag) => ({ value: tag, label: tag })),
  ];
}

// A tag removed from its last asset drops out of the menu, so fall back to every tag
export function activeTag(assets: readonly CatalogueAsset[], tag: string): string {
  return tag !== "all" && catalogueTags(assets).includes(tag) ? tag : "all";
}

export function filterAssets(
  assets: readonly CatalogueAsset[],
  filter: AssetFilter,
  favourites: readonly string[],
  query = "",
  tag = "all",
): CatalogueAsset[] {
  // Share literal name/category matching with the existing library behavior and preserve catalogue order
  const category = filter.startsWith("category:") ? filter.slice("category:".length) : "All";
  const matches = searchAssets(assets, query, category);

  // Favourites and the tag menu narrow the same results rather than bypassing the active search
  const tagged = tag === "all" ? matches : matches.filter((asset) => asset.tags?.includes(tag));
  return filter === "favourites" ? tagged.filter((asset) => favourites.includes(asset.id)) : tagged;
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
