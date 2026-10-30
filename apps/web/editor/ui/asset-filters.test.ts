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

const assets = [asset("vase", "Pottery"), asset("mask", "Artefacts"), asset("bowl", "Pottery")];

describe("asset filters", () => {
  it("lists each category once, after all and favourites", () => {
    expect(filterOptions(assets).map((option) => option.label)).toEqual([
      "All assets",
      "Favourites",
      "Artefacts",
      "Pottery",
    ]);
  });

  it("leaves categories out when the catalogue has none", () => {
    expect(filterOptions([asset("crate")]).map((option) => option.value)).toEqual([
      "all",
      "favourites",
    ]);
  });

  it("filters by category and by favourites", () => {
    expect(filterAssets(assets, "category:Pottery", []).map((item) => item.id)).toEqual([
      "vase",
      "bowl",
    ]);
    expect(filterAssets(assets, "favourites", ["mask"]).map((item) => item.id)).toEqual(["mask"]);
    expect(filterAssets(assets, "all", [])).toHaveLength(3);
  });

  it("toggles a favourite on and off", () => {
    expect(toggleFavourite([], "vase")).toEqual(["vase"]);
    expect(toggleFavourite(["vase", "mask"], "vase")).toEqual(["mask"]);
  });
});

describe("remembered favourites", () => {
  it("saves and loads, ignoring junk", () => {
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
