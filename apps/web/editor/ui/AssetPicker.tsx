import { useState } from "react";
import { assetDragType, type CatalogueAsset } from "../../shared/assets/catalogue";
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
  onDragChange: (dragging: boolean) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [favourites, setFavourites] = useState<string[]>(loadFavourites);
  const shown = filterAssets(assets, filter, favourites);

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
          {/* Search is being done separately, the box is here ready for it */}
          <input
            type="search"
            placeholder="Search for something…"
            aria-label="Search assets"
            disabled
          />
          <span className="asset-filter">
            <select
              aria-label="Filter assets"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            >
              {filterOptions(assets).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Icon name="caretSolid" />
          </span>
        </div>
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
          {filter === "favourites"
            ? "No favourites yet. Tap the heart on an asset to keep it here."
            : "Nothing in this category yet."}
        </p>
      ) : (
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
                  onClick={() => setChosen(asset.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(assetDragType, asset.id);
                    event.dataTransfer.effectAllowed = "copy";
                    onDragChange(true);
                  }}
                  onDragEnd={(event) => {
                    onDragChange(false);
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
      )}

      <button
        className="ui-button pill-button asset-picker-add"
        type="button"
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
