import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import {
  filterAssets,
  filterOptions,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
} from "./asset-filters";

afterEach(() => {
  vi.unstubAllGlobals();
});

function asset(id: string, category?: string): CatalogueAsset {
  const base = { id, name: id, kind: "model", url: "", sha256: "", thumbnail: null } as const;
  return (category === undefined ? base : { ...base, category }) as CatalogueAsset;
}

// Retain older delivered tags to prove searching does not rename or rewrite catalogue entries
const assets = [asset("vase", "Pottery"), asset("mask", "Artefacts"), asset("bowl", "Pottery")];

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

  it("filters by category and by favourites", () => {
    expect(filterAssets(assets, "category:Pottery", []).map((item) => item.id)).toEqual([
      "vase",
      "bowl",
    ]);
    expect(filterAssets(assets, "favourites", ["mask"]).map((item) => item.id)).toEqual(["mask"]);
    expect(filterAssets(assets, "all", [])).toHaveLength(3);
  });

  it("combines literal name search with categories and favourites without changing the catalogue", () => {
    // Combine each browsing constraint and keep punctuation literal instead of interpreting patterns
    const original = assets.slice();
    expect(filterAssets(assets, "category:Pottery", [], "  BOWL  ")).toEqual([assets[2]]);
    expect(filterAssets(assets, "favourites", ["mask", "vase"], "MASK")).toEqual([assets[1]]);
    expect(filterAssets(assets, "category:Artefacts", [], "bowl")).toEqual([]);
    expect(filterAssets(assets, "all", [], ".*")).toEqual([]);
    expect(filterAssets(assets, "all", [], "<script>")).toEqual([]);
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
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    });
    saveFavourites(["vase"]);
    expect(loadFavourites()).toEqual(["vase"]);
    values.set("spatia-favourite-assets", '["mask", 3, null]');
    expect(loadFavourites()).toEqual(["mask"]);
    values.set("spatia-favourite-assets", "not json");
    expect(loadFavourites()).toEqual([]);
  });

  it("starts empty when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
    expect(() => saveFavourites(["vase"])).not.toThrow();
    expect(loadFavourites()).toEqual([]);
  });
});
