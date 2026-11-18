import { afterEach, describe, expect, it } from "vitest";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import {
  filterAssets,
  filterOptions,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
} from "./asset-filters";

afterEach(() => {
  localStorage.removeItem("spatia-favourite-assets");
});

function asset(id: string, category: string): CatalogueAsset {
  return { id, name: id, kind: "model", url: "", sha256: "", thumbnail: null, category };
}

const assets = [asset("vase", "Objects"), asset("coat", "Clothing"), asset("bowl", "Objects")];

describe("asset filters", () => {
  it("lists the full agreed 3D categories in order, including categories without sample assets", () => {
    expect(filterOptions(assets).map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "all", label: "All assets" },
      { value: "favourites", label: "Favourites" },
      { value: "category:Objects", label: "Objects" },
      { value: "category:Furniture", label: "Furniture" },
      { value: "category:Architecture", label: "Architecture" },
      { value: "category:Clothing", label: "Clothing" },
      { value: "category:Tools & Equipment", label: "Tools & Equipment" },
    ]);
    // Availability changes with the delivered catalogue while the agreed option order stays fixed
    expect(
      filterOptions([asset("chair", "Furniture")]).find(
        (option) => option.value === "category:Furniture",
      )?.disabled,
    ).toBe(false);
    expect(
      filterOptions(assets).find((option) => option.value === "category:Furniture")?.disabled,
    ).toBe(true);
    expect(filterAssets(assets, "category:Furniture", [])).toEqual([]);
  });

  it("combines literal name search with categories and favourites without changing the catalogue", () => {
    // Combine each browsing constraint and keep punctuation literal instead of interpreting patterns
    const original = assets.slice();
    expect(filterAssets(assets, "category:Objects", [], "  BOWL  ")).toEqual([assets[2]]);
    expect(filterAssets(assets, "category:Clothing", [], "bowl")).toEqual([]);
    expect(filterAssets(assets, "favourites", ["coat", "vase"], "COAT")).toEqual([assets[1]]);
    expect(filterAssets(assets, "favourites", ["vase"], "coat")).toEqual([]);
    expect(filterAssets(assets, "all", [], ".*")).toEqual([]);
    expect(filterAssets(assets, "all", [], " ")).toEqual(assets);
    expect(assets).toEqual(original);
  });

  it("toggles a favourite on and off", () => {
    expect(toggleFavourite([], "vase")).toEqual(["vase"]);
    expect(toggleFavourite(["vase", "mask"], "vase")).toEqual(["mask"]);
  });
});

describe("remembered favourites", () => {
  it("saves and loads, ignoring junk", () => {
    // Model storage independently so persistence checks cannot leak favourites between tests
    saveFavourites(["vase"]);
    expect(loadFavourites()).toEqual(["vase"]);
    localStorage.setItem("spatia-favourite-assets", '["mask", 3, null]');
    expect(loadFavourites()).toEqual(["mask"]);
    localStorage.setItem("spatia-favourite-assets", "not json");
    expect(loadFavourites()).toEqual([]);
  });
});
