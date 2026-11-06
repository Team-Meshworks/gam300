import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type {
  ContentComponent,
  ContentObject,
  TextMark,
} from "../../shared/project/project-content";
import type { ProjectDocument, ProjectObject, Transform } from "../../shared/project/project-types";
import { Dialog } from "../../shared/ui/Dialog";
import type { createDocumentStore } from "../document-store";
import { displayPosition } from "../display-position";
import { AssetFilterSelect } from "./AssetFilterSelect";
import {
  categoryOf,
  filterAssets,
  filterOptions,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
} from "./asset-filters";
import textIcon from "./assets/editor-text.svg?no-inline";
import videoIcon from "./assets/editor-video.svg?no-inline";
import imageIcon from "./assets/editor-image.svg?no-inline";
import videoSelected from "./assets/editor-video-selected-bg.svg?no-inline";
import librarySelected from "./assets/editor-library-selected.svg?no-inline";
import { Icon } from "./Icon";
import "./display-editor.css";

const kinds = ["text", "video", "image"] as const;
type Kind = (typeof kinds)[number];
const labels = { text: "Text", video: "Video", image: "Image" };
const icons = { text: textIcon, video: videoIcon, image: imageIcon };
function Art({ src, className }: { src: string; className?: string }) {
  return <img src={src} className={className} alt="" aria-hidden="true" draggable={false} />;
}

export function DisplayEditor({
  object,
  initialKind,
  asset,
  assets,
  project,
  store,
  thumbnailFor,
  placementFor,
  onClose,
}: {
  object: ProjectObject;
  initialKind?: Kind;
  asset: CatalogueAsset;
  assets: readonly CatalogueAsset[];
  project: ProjectDocument;
  store: ReturnType<typeof createDocumentStore>;
  thumbnailFor: (assetId: string) => string | undefined;
  placementFor: (ownerId: string, assetId: string) => Transform | undefined;
  onClose: () => void;
}) {
  const id = useId();
  const tablist = useRef<HTMLDivElement>(null);
  const [openedProject] = useState(project);
  const existing = (object as ContentObject).components?.find((c) =>
    ["text", "image", "video"].includes(c.type),
  );
  const [type, setType] = useState<Kind>(
    initialKind ??
      (existing?.type === "image" || existing?.type === "video" ? existing.type : "text"),
  );
  const initialText = existing?.type === "text" ? existing.runs.map((r) => r.text).join("") : "";
  const [text, setText] = useState(initialText);
  const [marks, setMarks] = useState<readonly TextMark[]>(
    existing?.type === "text" ? (existing.runs[0]?.marks ?? []) : [],
  );
  const [formatChanged, setFormatChanged] = useState(false);
  const caption = existing && "caption" in existing ? existing.caption : "";
  const physical = asset.displayRole === "physical";
  const attached = store
    .getSnapshot()
    .objects.find((entry) => "parentId" in entry && entry.parentId === object.id);
  const [choices, setChoices] = useState<Record<string, string>>({
    physical: attached?.assetId ?? "",
    image: existing?.type === "image" ? existing.assetId : "",
    video: existing?.type === "video" ? existing.assetId : "",
  });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [favourites, setFavourites] = useState(loadFavourites);
  const [error, setError] = useState("");
  const candidates = assets.filter((a) =>
    physical
      ? a.kind === "model" && !a.displayRole && a.id !== "test-room-module-v1"
      : a.kind === type,
  );
  const shown = filterAssets(candidates, filter, favourites, query);
  const choiceKey = physical ? "physical" : type;
  const chosen = candidates.find((a) => a.id === choices[choiceKey]);
  const textMode = !physical && type === "text";
  const title = physical ? "Assets" : labels[type];
  function current() {
    if (store.getSnapshot().project !== openedProject) {
      setError("The project changed. Close this editor and select the display again.");
      return false;
    }
    return true;
  }
  function save() {
    if (!current()) return;
    if (physical) {
      if (!chosen) return;
      const fitted = placementFor(object.id, chosen.id);
      if (!fitted) {
        setError("This object does not fit the display. Choose a smaller object.");
        return;
      }
      const result = store.addAttachedObject(
        chosen.id,
        object.id,
        displayPosition(object, asset.displayTop ?? 0),
        fitted,
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
    } else {
      const componentId = existing?.id ?? crypto.randomUUID();
      if (!textMode && !chosen) return;
      const component: ContentComponent =
        type === "text"
          ? {
              id: componentId,
              type,
              runs:
                existing?.type === "text" && text === initialText && !formatChanged
                  ? existing.runs
                  : [{ text, marks }],
              caption,
            }
          : type === "image"
            ? {
                id: componentId,
                type,
                assetId: chosen!.id,
                caption,
                alt:
                  existing?.type === "image" && existing.assetId === chosen!.id
                    ? existing.alt
                    : caption,
              }
            : {
                id: componentId,
                type,
                assetId: chosen!.id,
                caption,
                loop: existing?.type === "video" ? existing.loop : false,
                volume: existing?.type === "video" ? existing.volume : 1,
              };
      const result = store.setDisplayContent(object.id, component);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
    }
    onClose();
  }
  function selectTab(kind: Kind) {
    setType(kind);
    setError("");
  }
  function tabKeys(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key))
      return;
    event.preventDefault();
    const index = kinds.indexOf(type);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? kinds.length - 1
          : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + kinds.length) %
            kinds.length;
    selectTab(kinds[next]!);
    tablist.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  return (
    <Dialog
      title={physical ? "Place an object on this display" : "Edit display content"}
      onClose={onClose}
      variant="display"
    >
      <div className={`display-editor${textMode ? " is-text" : ""}`}>
        <aside className="display-editor-rail">
          {physical ? (
            <>
              <span
                className="display-tab-background is-selected"
                style={{ maskImage: `url(${videoSelected})` }}
                aria-hidden="true"
              />
              <Icon name="library" />
            </>
          ) : (
            <div
              ref={tablist}
              role="tablist"
              aria-label="Content type"
              aria-orientation="vertical"
              onKeyDown={tabKeys}
            >
              {kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  id={`${id}-${kind}`}
                  aria-controls={`${id}-panel`}
                  aria-selected={type === kind}
                  aria-label={labels[kind]}
                  title={labels[kind]}
                  tabIndex={type === kind ? 0 : -1}
                  onClick={() => selectTab(kind)}
                >
                  <span
                    className="display-tab-background"
                    style={{ maskImage: `url(${videoSelected})` }}
                    aria-hidden="true"
                  />
                  <Art src={icons[kind]} className="display-tab-icon" />
                </button>
              ))}
            </div>
          )}
        </aside>
        <section
          className="display-editor-main"
          id={`${id}-panel`}
          role={physical ? undefined : "tabpanel"}
          aria-labelledby={physical ? undefined : `${id}-${type}`}
        >
          <header className="asset-picker-head">
            <h3 className="asset-picker-title">
              <Icon name="info" />
              {title}
            </h3>
            {!textMode && (
              <div className="asset-search">
                <Icon name="search" />
                <input
                  type="search"
                  aria-label="Search library"
                  placeholder="Search for something…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <AssetFilterSelect
                  value={filter}
                  options={filterOptions(candidates)}
                  onChange={setFilter}
                />
              </div>
            )}
            {!textMode && (
              <button
                type="button"
                className="ui-button asset-picker-reset"
                aria-label="Reset asset filters"
                disabled={query === "" && filter === "all"}
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Reset
              </button>
            )}
            <button
              type="button"
              className="ui-button asset-picker-close"
              aria-label="Close display editor"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </header>
          {textMode ? (
            <div className="display-text-pad">
              <textarea
                aria-label="Display text"
                placeholder="Write something for your display…"
                maxLength={65536}
                value={text}
                onChange={(e) => setText(e.target.value)}
                style={{
                  fontWeight: marks.includes("bold") ? "bold" : undefined,
                  fontStyle: marks.includes("italic") ? "italic" : undefined,
                  textDecoration: marks.includes("underline") ? "underline" : undefined,
                }}
              />
              <div className="display-format" role="group" aria-label="Format all display text">
                <button
                  type="button"
                  aria-label="Clear text formatting"
                  onClick={() => {
                    setMarks([]);
                    setFormatChanged(true);
                  }}
                >
                  Tt
                </button>
                {(["bold", "italic", "underline"] as const).map((mark) => (
                  <button
                    key={mark}
                    type="button"
                    aria-label={mark}
                    aria-pressed={marks.includes(mark)}
                    className={`format-${mark}`}
                    onClick={() => {
                      setMarks(
                        marks.includes(mark) ? marks.filter((m) => m !== mark) : [...marks, mark],
                      );
                      setFormatChanged(true);
                    }}
                  >
                    {mark[0]!.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="display-editor-library">
              {shown.length ? (
                <ul className="display-editor-cards asset-grid">
                  {shown.map((entry) => (
                    <li key={entry.id} className="asset-card">
                      <button
                        type="button"
                        className="display-card asset-card-pick"
                        aria-pressed={chosen?.id === entry.id}
                        aria-label={entry.name}
                        onClick={() => setChoices({ ...choices, [choiceKey]: entry.id })}
                      >
                        <span className="asset-art">
                          {thumbnailFor(entry.id) || entry.thumbnail ? (
                            <img
                              className={
                                entry.kind === "image" || entry.kind === "video"
                                  ? "is-media-thumbnail"
                                  : undefined
                              }
                              src={thumbnailFor(entry.id) ?? entry.thumbnail ?? undefined}
                              alt=""
                              draggable={false}
                            />
                          ) : (
                            <span>Preview unavailable</span>
                          )}
                        </span>
                        <span className="asset-card-info">
                          <span className="asset-tag">
                            {categoryOf(entry) ?? (physical ? "Object" : title)}
                          </span>
                          <span className="asset-name">{entry.name}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ui-button display-card-favourite asset-favourite"
                        aria-label={`Favourite ${entry.name}`}
                        aria-pressed={favourites.includes(entry.id)}
                        onClick={() => {
                          const next = toggleFavourite(favourites, entry.id);
                          setFavourites(next);
                          saveFavourites(next);
                        }}
                      >
                        <Icon name={favourites.includes(entry.id) ? "heartFilled" : "heart"} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="display-editor-empty" role="status">
                  <Art src={physical ? librarySelected : icons[type]} />
                  <strong>
                    {candidates.length
                      ? "No matching assets"
                      : `No ${physical ? "objects" : type === "image" ? "images" : "videos"} in the library yet`}
                  </strong>
                  <p>
                    {candidates.length
                      ? "Try another search or filter."
                      : "Media must be registered in the asset catalogue before it can be added to a display."}
                  </p>
                  {candidates.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                    >
                      Clear search and filters
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {error && (
            <p className="display-editor-error" role="alert">
              {error}
            </p>
          )}
          <footer className="asset-picker-actions">
            {physical && (
              <p className="display-owner">
                Display<span>{object.name}</span>
              </p>
            )}
            <button
              type="button"
              className="ui-button pill-button asset-picker-add"
              disabled={textMode ? !text.trim() : !chosen}
              onClick={save}
            >
              Add
            </button>
          </footer>
        </section>
      </div>
    </Dialog>
  );
}
