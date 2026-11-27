import { LibraryRail } from "./LibraryRail";
import { useDragImage } from "./use-drag-image";
import { useEffect, useState } from "react";
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
import type { AssetPickerMode } from "./asset-selection";

const pickerLabels = {
  assets: {
    title: "Assets",
    library: "Asset library",
    icon: "library",
    placeholder: "Search for something…",
    search: "Search assets",
    close: "Close asset library",
  },
  rooms: {
    title: "Rooms",
    library: "Rooms",
    icon: "door",
    placeholder: "Search room layouts…",
    search: "Search rooms",
    close: "Close rooms",
  },
  furniture: {
    title: "Furniture",
    library: "Furniture library",
    icon: "bench",
    placeholder: "Search furniture…",
    search: "Search furniture",
    close: "Close furniture library",
  },
} as const;

// Pick a card then press Add, or double-click it. Dragging a card into the scene works too
export function AssetPicker({
  assets,
  ready,
  thumbnailFor,
  onAdd,
  onChoose,
  onDragChange,
  onClose,
  mode = "assets",
}: {
  assets: readonly CatalogueAsset[];
  ready: boolean;
  thumbnailFor: (assetId: string) => string | undefined;
  onAdd: (assetId: string) => void;
  onChoose?: ((assetId: string | null) => void) | undefined;
  onDragChange: (assetId: string | null) => void;
  onClose: () => void;
  mode?: AssetPickerMode;
}) {
  const rooms = mode === "rooms";
  const furniture = mode === "furniture";
  const labels = pickerLabels[mode];
  const setDragImage = useDragImage();
  const [chosen, setChosen] = useState<string | null>(null);
  function add(assetId: string) {
    try {
      onAdd(assetId);
    } finally {
      onClose();
    }
  }
  useEffect(() => () => onChoose?.(null), [onChoose]);
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
    <section
      className={`asset-picker has-library-rail${rooms ? " room-picker" : ""}`}
      data-picker-mode={mode}
      id="asset-panel"
      role={rooms ? "group" : undefined}
      aria-label={rooms ? "Rooms options" : undefined}
      aria-labelledby={rooms ? undefined : "assets-heading"}
    >
      <LibraryRail icon={labels.icon} label={labels.library} />
      <div className="asset-picker-head">
        <h2 id="assets-heading" className="asset-picker-title">
          <Icon
            name="info"
            title={
              furniture
                ? "Choose furniture to place in your scene"
                : "Choose an asset to place in your scene"
            }
          />
          {labels.title}
        </h2>
        <div className="asset-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder={labels.placeholder}
            aria-label={labels.search}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <AssetFilterSelect
            value={filter}
            label={furniture ? "Filter furniture" : "Filter assets"}
            options={
              furniture
                ? [
                    { value: "all", label: "All furniture" },
                    { value: "favourites", label: "Favourites" },
                  ]
                : filterOptions(assets)
            }
            onChange={setFilter}
          />
        </div>
        <button
          className="ui-button asset-picker-reset"
          type="button"
          aria-label={furniture ? "Reset furniture filters" : "Reset asset filters"}
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
          aria-label={labels.close}
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>

      {rooms && (
        <p className="room-picker-hint">
          Choose a room to add it to your scene. Adding another room requires an approved room
          model.
        </p>
      )}

      {shown.length === 0 ? (
        <p className="panel-empty asset-picker-empty">
          {query.trim()
            ? furniture
              ? "No furniture matches your search."
              : "No assets match this search and filter."
            : filter === "favourites"
              ? furniture
                ? "Tap the heart on a piece of furniture to save it here."
                : "No favourites yet. Tap the heart on an asset to keep it here."
              : furniture
                ? "No furniture is available."
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
                    title={
                      rooms
                        ? "Choose this room layout"
                        : "Double-click to add, or pick it then press Add, or drag it into the scene"
                    }
                    onClick={() => {
                      if (rooms) {
                        playUiSound("assetSelect");
                        onAdd(asset.id);
                        onClose();
                        return;
                      }
                      setChosen(asset.id);
                      onChoose?.(asset.id);
                      playUiSound("assetSelect");
                    }}
                    // The first click already chose it; the second adds it like the Add button
                    onDoubleClick={() => {
                      if (rooms) return;
                      add(asset.id);
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(assetDragType, asset.id);
                      event.dataTransfer.effectAllowed = "copy";
                      setDragImage(event.dataTransfer);
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
      {!rooms && (
        <button
          className="ui-button pill-button asset-picker-add"
          type="button"
          aria-describedby={chosenAsset !== undefined ? "asset-picker-selection" : undefined}
          disabled={chosen === null || !ready}
          onClick={() => {
            if (chosen !== null) add(chosen);
          }}
        >
          Add
        </button>
      )}
    </section>
  );
}
