import { useEffect, useRef, useState } from "react";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { ValidationResult } from "../../shared/project/validation-helpers";
import { AssetFilterSelect } from "./AssetFilterSelect";
import { loadFavourites, saveFavourites, toggleFavourite } from "./asset-filters";
import { Icon } from "./Icon";
import selectedRail from "./assets/editor-video-selected-bg.svg?no-inline";
import "./audio-library.css";

export type AudioLibraryMode = "background" | "spatial" | "narration";
export function AudioLibrary({
  assets,
  mode,
  targetName,
  onAdd,
  onClose,
}: {
  assets: readonly CatalogueAsset[];
  mode: AudioLibraryMode;
  targetName: string | null;
  onAdd: (id: string) => ValidationResult<true>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const initialFilter = mode === "background" ? "BGM" : "all";
  const [filter, setFilter] = useState(initialFilter);
  const [favourites, setFavourites] = useState(loadFavourites);
  const [error, setError] = useState("");
  // Background music keeps its category; spatial sources can use any approved clip
  const tracks = assets.filter(
    (asset) => asset.kind === "audio" && (mode !== "background" || asset.category === "BGM"),
  );
  const categories = [
    ...new Set(tracks.flatMap((asset) => (asset.category ? [asset.category] : []))),
  ];
  const shown = tracks.filter(
    (asset) =>
      asset.name.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "favourites" ? favourites.includes(asset.id) : asset.category === filter)),
  );
  // Opening is modal; closing releases the preview source so sound cannot leak into editing
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      const audio = player.current;
      player.current = null;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    };
  }, []);
  // Reuse one player for pause/resume and stop the previous clip before selecting another
  function preview(asset: CatalogueAsset) {
    let audio = player.current;
    if (audio?.getAttribute("src") === asset.url) {
      if (!audio.paused) {
        audio.pause();
        setPlaying(null);
        return;
      }
    } else {
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      audio = new Audio(asset.url);
      audio.preload = "none";
      player.current = audio;
      const current = audio;
      audio.onended = () => {
        if (player.current === current) setPlaying(null);
      };
    }
    setError("");
    setPlaying(asset.id);
    const current = audio;
    // Ignore late failures from replaced clips while keeping the current preview failure visible
    void audio.play().catch((error: unknown) => {
      if (
        player.current !== current ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      setPlaying(null);
      setError("This clip could not play. Try its preview again.");
    });
  }
  const blocked = mode !== "background" && targetName === null;
  return (
    <dialog
      ref={dialog}
      className="asset-picker audio-library"
      aria-labelledby="audio-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <aside className="audio-library-rail" aria-label="Audio library">
        <span
          className="audio-library-rail-shape"
          style={{ maskImage: `url(${selectedRail})` }}
          aria-hidden="true"
        />
        <Icon name="audioLibrary" />
      </aside>
      <header className="asset-picker-head">
        <h2 className="asset-picker-title" id="audio-heading">
          <Icon
            name="info"
            title={
              mode === "background"
                ? "Add background music to this scene"
                : "Attach sound to the selected object"
            }
          />
          Audio
        </h2>
        <div className="asset-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search audio"
            placeholder="Search for something…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <AssetFilterSelect
            label="Filter audio"
            value={filter}
            options={[
              { value: "all", label: "All audio" },
              { value: "favourites", label: "Favourites" },
              ...categories.map((category) => ({
                value: category,
                label: category,
                disabled: !tracks.some((asset) => asset.category === category),
              })),
            ]}
            onChange={setFilter}
          />
        </div>
        <button
          className="ui-button asset-picker-reset"
          type="button"
          aria-label="Reset audio filters"
          disabled={!query && filter === "all"}
          onClick={() => {
            setQuery("");
            setFilter("all");
          }}
        >
          Reset
        </button>
        <button
          className="ui-button asset-picker-close"
          type="button"
          aria-label="Close audio library"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="asset-grid-scroll">
        {shown.length ? (
          <ul className="asset-grid audio-grid">
            {shown.map((asset) => (
              <li className="asset-card" key={asset.id}>
                <button
                  type="button"
                  className="asset-card-pick"
                  aria-label={asset.name}
                  aria-pressed={chosen === asset.id}
                  onClick={() => setChosen(asset.id)}
                >
                  <span className="asset-art audio-art">
                    <img src={asset.thumbnail ?? undefined} alt="" draggable={false} />
                    <span className="audio-duration">
                      {Math.floor((asset.durationSeconds ?? 0) / 60)}:
                      {String(Math.floor((asset.durationSeconds ?? 0) % 60)).padStart(2, "0")}
                    </span>
                  </span>
                  <span className="asset-card-info">
                    <span className="asset-tag">{asset.category}</span>
                    <span className="asset-name">{asset.name}</span>
                  </span>
                </button>
                <button
                  className="audio-preview ui-button"
                  type="button"
                  aria-label={`${playing === asset.id ? "Pause" : "Preview"} ${asset.name}`}
                  aria-pressed={playing === asset.id}
                  onClick={() => preview(asset)}
                >
                  <Icon name={playing === asset.id ? "audioPause" : "audioPlay"} />
                </button>
                <button
                  className="ui-button asset-favourite"
                  type="button"
                  aria-label={`Favourite ${asset.name}`}
                  aria-pressed={favourites.includes(asset.id)}
                  onClick={() => {
                    const next = toggleFavourite(favourites, asset.id);
                    setFavourites(next);
                    saveFavourites(next);
                  }}
                >
                  <Icon name={favourites.includes(asset.id) ? "heartFilled" : "heart"} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel-empty asset-picker-empty" role="status">
            {query || filter === "favourites"
              ? "No audio matches this search and filter."
              : "No clips in this category yet. Choose All audio to browse available clips."}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="audio-library-feedback">
          {error}
        </p>
      )}
      <footer className="asset-picker-actions">
        <span className="audio-library-target">
          {blocked
            ? "Select an object for spatial audio."
            : mode === "background"
              ? "Scene background audio"
              : targetName}
        </span>
        <button
          type="button"
          className="ui-button pill-button asset-picker-add"
          disabled={!chosen || blocked}
          onClick={() => {
            if (!chosen) return;
            // Close only after the document command succeeds so rejected additions keep the choice
            const result = onAdd(chosen);
            if (result.ok) onClose();
            else setError(result.error.message);
          }}
        >
          Add
        </button>
      </footer>
    </dialog>
  );
}
