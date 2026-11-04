import { useState } from "react";
import { assetDragType, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { playUiSound } from "../audio/ui-sounds";
import {
  categoryOf,
  filterAssets,
  filterOptions,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
  type AssetFilter,
} from "./asset-filters";
import { Icon } from "./Icon";
import { AssetFilterSelect } from "./AssetFilterSelect";

// Pick a card then press Add. Dragging a card straight into the scene still works too
export function AssetPicker({
  assets,
  ready,
  thumbnailFor,
  onAdd,
  onDragChange,
  onClose,
}: {
  assets: readonly CatalogueAsset[];
  ready: boolean;
  thumbnailFor: (assetId: string) => string | undefined;
  onAdd: (assetId: string) => void;
  onDragChange: (assetId: string | null) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [favourites, setFavourites] = useState<string[]>(loadFavourites);
  // Browsing changes only local controls; the chosen stable ID and placement history stay intact
  const shown = filterAssets(assets, filter, favourites, query);
  const chosenAsset = assets.find((asset) => asset.id === chosen);
  // Keep the chosen ID available to assistive technology when browsing hides its card
  const chosenHidden = chosenAsset !== undefined && !shown.includes(chosenAsset);

  // Update the current view immediately and retain favourites independently of the project draft
  function favourite(id: string) {
    const next = toggleFavourite(favourites, id);
    setFavourites(next);
    saveFavourites(next);
  }

  return (
    <section className="asset-picker" id="asset-panel" aria-labelledby="assets-heading">
      <div className="asset-picker-head">
        <h2 id="assets-heading" className="asset-picker-title">
          <Icon name="info" />
          Assets
        </h2>
        <div className="asset-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Search for something…"
            aria-label="Search assets"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <AssetFilterSelect value={filter} options={filterOptions(assets)} onChange={setFilter} />
        </div>
        <button
          className="ui-button asset-picker-reset"
          type="button"
          aria-label="Reset asset filters"
          disabled={query === "" && filter === "all"}
          onClick={() => {
            // Clear browsing restrictions without losing the selected card or changing the scene
            setQuery("");
            setFilter("all");
          }}
        >
          Reset
        </button>
        <button
          className="ui-button asset-picker-close"
          type="button"
          aria-label="Close asset library"
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="panel-empty asset-picker-empty">
          {query.trim()
            ? "No assets match this search and filter."
            : filter === "favourites"
              ? "No favourites yet. Tap the heart on an asset to keep it here."
              : "Nothing in this category yet."}
        </p>
      ) : (
        // Keep the scrolling viewport separate so masonry columns grow down instead of sideways
        <div className="asset-grid-scroll">
          <ul className="asset-grid" role="list">
            {shown.map((asset) => {
              const category = categoryOf(asset);
              const isFavourite = favourites.includes(asset.id);
              return (
                <li key={asset.id} className="asset-card">
                  <button
                    className="asset-card-pick"
                    type="button"
                    draggable={ready}
                    disabled={!ready}
                    aria-label={asset.name}
                    aria-pressed={chosen === asset.id}
                    title="Pick it then press Add, or drag it into the scene"
                    onClick={() => {
                      setChosen(asset.id);
                      playUiSound("assetSelect");
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(assetDragType, asset.id);
                      event.dataTransfer.effectAllowed = "copy";
                      onDragChange(asset.id);
                    }}
                    onDragEnd={(event) => {
                      onDragChange(null);
                      // Only close when it really landed in the scene, a cancelled drag keep it open
                      if (event.dataTransfer.dropEffect !== "none") onClose();
                    }}
                  >
                    <span className="asset-art">
                      <img src={thumbnailFor(asset.id)} alt="" draggable={false} />
                    </span>
                    <span className="asset-card-info">
                      {category !== undefined && <span className="asset-tag">{category}</span>}
                      <span className="asset-name">{asset.name}</span>
                    </span>
                  </button>
                  <button
                    className="ui-button asset-favourite"
                    type="button"
                    aria-label={`Favourite ${asset.name}`}
                    aria-pressed={isFavourite}
                    onClick={() => favourite(asset.id)}
                  >
                    <Icon name={isFavourite ? "heartFilled" : "heart"} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {chosenAsset !== undefined && (
        <p id="asset-picker-selection" className="sr-only" aria-live="polite">
          {chosenHidden
            ? `Selected: ${chosenAsset.name} (not shown in the current results)`
            : `Selected: ${chosenAsset.name}`}
        </p>
      )}
      <button
        className="ui-button pill-button asset-picker-add"
        type="button"
        aria-describedby={chosenAsset !== undefined ? "asset-picker-selection" : undefined}
        disabled={chosen === null || !ready}
        onClick={() => {
          if (chosen === null) return;
          onAdd(chosen);
          onClose();
        }}
      >
        Add
      </button>
    </section>
  );
}
