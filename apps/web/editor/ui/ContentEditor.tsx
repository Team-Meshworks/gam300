import { ColorSwatches } from "./ColorSwatches";
import { textColorOn } from "../../shared/project/project-appearance";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { SceneObject } from "../../shared/project/scene-object";
import type { Transform } from "../../shared/project/project-types";
import type {
  ContentComponent,
  ContentObject,
  TextMark,
} from "../../shared/project/project-content";
import type { ValidationResult } from "../../shared/project/validation-helpers";
import { markTextRuns } from "./text-runs";
import { RichTextInput, type RichTextInputHandle } from "./RichTextInput";
import { Icon } from "./Icon";
import { AssetFilterSelect } from "./AssetFilterSelect";
import { loadFavourites, saveFavourites, toggleFavourite } from "./asset-filters";
import textIcon from "./assets/editor-text.svg?no-inline";
import videoIcon from "./assets/editor-video.svg?no-inline";
import imageIcon from "./assets/editor-image.svg?no-inline";
import videoSelected from "./assets/editor-video-selected-bg.svg?no-inline";
import "./content-editor.css";
const contentIcons = { text: textIcon, video: videoIcon, image: imageIcon };

export type ContentKind = "text" | "image" | "video";
export type ContentMedia = Readonly<{
  id: string;
  name: string;
  kind: "image" | "audio" | "video";
  url: string;
  thumbnail?: string | null;
  category?: string;
}>;
const kinds: ContentKind[] = ["text", "video", "image"];
const labels = { text: "Text", image: "Image", video: "Video" };
export type ExhibitFields = Readonly<{
  name: string;
  transform: Transform;
  components: readonly ContentComponent[];
}>;

// Catalogue IDs are authored; URLs are used only to preview media already supplied by the host
function newContent(type: ContentKind): ContentComponent {
  // Allocate once for the draft; edits and undo keep this component's identity
  const id = crypto.randomUUID();
  switch (type) {
    case "text":
      return { id, type, runs: [], caption: "" };
    case "image":
      return { id, type, assetId: "", caption: "", alt: "" };
    case "video":
      return { id, type, assetId: "", caption: "", loop: false, volume: 1 };
  }
}

export function ContentEditor({
  object,
  initialKind,
  media = [],
  displayMedia = false,
  onSave,
  onClose,
}: {
  object: SceneObject;
  initialKind: ContentKind;
  media?: readonly ContentMedia[];
  displayMedia?: boolean;
  onSave: (before: SceneObject, fields: ExhibitFields) => ValidationResult<true>;
  onClose: () => void;
}) {
  // Keep edits private until Save; retained IDs and the captured object detect stale forms
  const [before] = useState(object);
  const [components, setComponents] = useState<readonly ContentComponent[]>(() => {
    const existing = (object as Partial<ContentObject>).components ?? [];
    const available = initialKind === "text";
    return available && !existing.some((item) => item.type === initialKind)
      ? [...existing, newContent(initialKind)]
      : existing;
  });
  const [kind, setKind] = useState(initialKind);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [marks, setMarks] = useState<readonly TextMark[]>([]);
  const [palette, setPalette] = useState<"background" | "color" | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [favourites, setFavourites] = useState(loadFavourites);
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<RichTextInputHandle>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const component =
    components.find((item) => item.id === activeId) ??
    components.find((item) => item.type === kind);
  const choices = media.filter((item) => item.kind === kind);
  const shown = choices.filter(
    (item) =>
      item.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter !== "favourites" || favourites.includes(item.id)),
  );
  const source =
    component && "assetId" in component
      ? choices.find((item) => item.id === component.assetId)
      : undefined;
  // Restore focus to the toolbar after either choice; StrictMode closes only this modal
  useEffect(() => {
    const modal = dialog.current;
    const trigger = document.activeElement;
    modal?.showModal();
    return () => {
      modal?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  const occupied = components.some((item) => item.type === "image" || item.type === "video");
  function choose(next: ContentKind) {
    if (next === "text" && occupied) return;
    let selected = components.find((item) => item.type === next);
    // Browsing an unavailable catalogue must not insert an invalid placeholder into another edit
    if (!selected && next !== "text") {
      setKind(next);
      setActiveId(null);
      setError("");
      return;
    }
    if (!selected) {
      selected = newContent(next);
      setComponents((items) => [...items, selected!]);
    }
    setKind(next);
    setActiveId(selected.id);
    setError("");
  }
  function update(next: ContentComponent) {
    // Replace only this draft component; retain the other types and their authored order
    setComponents((items) => items.map((item) => (item.id === next.id ? next : item)));
  }
  function format(mark: TextMark) {
    // A range changes only those characters; a caret chooses formatting for new typing
    if (component?.type !== "text") return;
    const input = textarea.current;
    const [start, end] = input?.selection() ?? [0, 0];
    if (input && start !== end) {
      update({
        ...component,
        runs: markTextRuns(component.runs, start, end, mark),
      });
    } else {
      setMarks((current) =>
        current.includes(mark) ? current.filter((value) => value !== mark) : [...current, mark],
      );
    }
    input?.focus();
  }
  function save(event: FormEvent) {
    event.preventDefault();
    const result = onSave(before, {
      name: before.name,
      transform: before.transform,
      // One screen has one active content item; keep unrelated attached components.
      components:
        displayMedia && component
          ? [
              component,
              ...components.filter((item) => !["text", "image", "video"].includes(item.type)),
            ]
          : component
            ? [component, ...components.filter((item) => item.id !== component.id)]
            : components,
    });
    if (!result.ok) {
      setError(`${result.error.path}: ${result.error.message}`);
      return;
    }
    onClose();
  }

  // Native modality keeps scene placement and global shortcuts outside a pending content edit
  return (
    <dialog
      ref={dialog}
      className={`content-dialog pdf-content-dialog content-dialog-${kind}`}
      aria-labelledby="content-heading"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && palette) {
          event.preventDefault();
          setPalette(null);
        }
      }}
      onPointerDownCapture={(event) => {
        if (
          palette &&
          event.target instanceof Element &&
          !event.target.closest(
            '.color-palette,[aria-label="Text color"],[aria-label="Text background"]',
          )
        )
          setPalette(null);
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={save}>
        <header className="asset-picker-head">
          <h2 id="content-heading" className="asset-picker-title">
            <Icon name="info" />
            {labels[kind]}
          </h2>
          {kind !== "text" && (
            <div className="asset-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search media"
                placeholder="Search for something…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <AssetFilterSelect
                value={filter}
                options={[
                  { value: "all", label: "All assets" },
                  { value: "favourites", label: "Favourites" },
                ]}
                onChange={setFilter}
              />
            </div>
          )}
          {kind !== "text" && (
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
            className="ui-button asset-picker-close"
            type="button"
            aria-label="Cancel content editing"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="content-layout">
          <nav className="content-tabs" aria-label="Content types">
            {kinds
              .filter((type) => (type !== "image" && type !== "video") || displayMedia)
              .map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-label={labels[type]}
                  disabled={type === "text" && occupied}
                  title={labels[type]}
                  aria-pressed={kind === type}
                  onClick={() => choose(type)}
                >
                  <span
                    className="content-tab-background"
                    style={{ maskImage: `url(${videoSelected})` }}
                    aria-hidden="true"
                  />
                  <img
                    className="content-tab-icon"
                    src={contentIcons[type]}
                    alt=""
                    draggable={false}
                  />
                  <span className="content-tab-label">{labels[type]}</span>
                </button>
              ))}
          </nav>
          <div className="content-fields">
            {kind !== "text" && (
              <div className="asset-grid-scroll" aria-label={`${labels[kind]} library`}>
                <ul className="asset-grid">
                  {shown.map((item) => (
                    <li className="asset-card" key={item.id}>
                      <button
                        type="button"
                        className="asset-card-pick"
                        aria-label={item.name}
                        aria-pressed={source?.id === item.id}
                        onClick={() => {
                          if (component && component.type === kind)
                            update({ ...component, assetId: item.id });
                          else {
                            const next = {
                              ...newContent(kind),
                              assetId: item.id,
                              ...(kind === "image" ? { alt: item.name } : {}),
                            };
                            setComponents((items) => [...items, next]);
                            setActiveId(next.id);
                          }
                        }}
                      >
                        <span className="asset-art">
                          <img
                            src={item.thumbnail ?? (kind === "image" ? item.url : undefined)}
                            alt=""
                            draggable={false}
                            loading="lazy"
                          />
                        </span>
                        <span className="asset-card-info">
                          <span className="asset-tag">{item.category ?? labels[kind]}</span>
                          <span className="asset-name">{item.name}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ui-button asset-favourite"
                        aria-label={`Favourite ${item.name}`}
                        aria-pressed={favourites.includes(item.id)}
                        onClick={() => {
                          const next = toggleFavourite(favourites, item.id);
                          setFavourites(next);
                          saveFavourites(next);
                        }}
                      >
                        <Icon name={favourites.includes(item.id) ? "heartFilled" : "heart"} />
                      </button>
                    </li>
                  ))}
                </ul>
                {shown.length === 0 && (
                  <p role="status">
                    {choices.length
                      ? "No matching media"
                      : `No approved ${kind} is available in this catalogue.`}
                  </p>
                )}
              </div>
            )}
            {component && (
              <>
                <div
                  className="content-items"
                  aria-label="Attached content"
                  hidden={components.filter((item) => item.type === kind).length < 2}
                >
                  {components
                    .filter((item) => item.type === kind)
                    .map((item, index) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-pressed={component.id === item.id}
                        onClick={() => setActiveId(item.id)}
                      >
                        {labels[kind]} {index + 1}
                      </button>
                    ))}
                  <button
                    type="button"
                    onClick={() => {
                      const next = newContent(kind);
                      setComponents((items) => [...items, next]);
                      setActiveId(next.id);
                    }}
                  >
                    + Add {labels[kind].toLowerCase()}
                  </button>
                </div>
                {component.type === "text" && (
                  <>
                    <label className="content-text-label">
                      <span className="content-tab-label">Text</span>
                      <div
                        className="content-text-surface"
                        style={
                          {
                            background:
                              component.background && component.background !== "transparent"
                                ? component.background
                                : undefined,
                            "--content-font-size": `${component.fontSize ?? (displayMedia ? 24 : 28)}px`,
                            "--content-ink":
                              component.color ??
                              (component.background && component.background !== "transparent"
                                ? textColorOn(component.background)
                                : undefined),
                          } as CSSProperties
                        }
                      >
                        <RichTextInput
                          ref={textarea}
                          value={component.runs}
                          marks={marks}
                          onFormat={format}
                          onChange={(runs) => update({ ...component, runs })}
                        />
                      </div>
                    </label>
                    <div className="content-format" role="group" aria-label="Text formatting">
                      <span className="content-font-size" onClickCapture={() => setPalette(null)}>
                        <AssetFilterSelect
                          label="Font size"
                          tooltip="Font Size"
                          icon={<Icon name="caretDown" />}
                          minWidth={96}
                          maxHeight={360}
                          value={String(component.fontSize ?? (displayMedia ? 24 : 28))}
                          options={[12, 16, 20, 24, 28, 32, 40, 48].map((size) => ({
                            value: String(size),
                            label: String(size),
                          }))}
                          onChange={(value) => update({ ...component, fontSize: Number(value) })}
                        />
                      </span>
                      <span className="content-color-control">
                        <button
                          type="button"
                          className="content-background-control"
                          aria-label="Text color"
                          aria-expanded={palette === "color"}
                          onClick={() => setPalette(palette === "color" ? null : "color")}
                        >
                          <span
                            className="content-text-color-icon"
                            style={{ borderBottomColor: component.color ?? "var(--content-ink)" }}
                            aria-hidden="true"
                          >
                            <Icon name="text" />
                          </span>
                          <span className="content-control-tooltip" role="tooltip">
                            Text Color
                          </span>
                        </button>
                        {palette === "color" && (
                          <div
                            className="content-background-palette color-palette is-compact"
                            role="group"
                            aria-label="Text colors"
                          >
                            <ColorSwatches
                              compact
                              foreground
                              value={component.color}
                              onChange={(color) => {
                                update({ ...component, color });
                              }}
                            />
                          </div>
                        )}
                      </span>
                      {
                        <span className="content-color-control">
                          <button
                            type="button"
                            className="content-background-control"
                            aria-label="Text background"
                            aria-expanded={palette === "background"}
                            onClick={() =>
                              setPalette(palette === "background" ? null : "background")
                            }
                          >
                            <span
                              className="content-background-icon"
                              style={{
                                background: component.background ?? "var(--content-screen)",
                              }}
                              aria-hidden="true"
                            />
                            <span className="content-control-tooltip" role="tooltip">
                              Background Color
                            </span>
                          </button>
                          {palette === "background" && (
                            <div
                              className="content-background-palette color-palette is-compact"
                              role="group"
                              aria-label="Text background colors"
                            >
                              <ColorSwatches
                                compact
                                backgrounds
                                value={component.background}
                                onChange={(background) => {
                                  update({ ...component, background });
                                }}
                              />
                            </div>
                          )}
                        </span>
                      }
                      <button
                        type="button"
                        aria-label="Clear text formatting"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => {
                          if (component.type === "text")
                            update({
                              ...component,
                              runs: component.runs.map((run) => ({ ...run, marks: [] })),
                            });
                          setMarks([]);
                        }}
                      >
                        Tt
                        <span className="content-control-tooltip" role="tooltip">
                          Clear Formatting
                        </span>
                      </button>
                      {(["bold", "italic", "underline"] as const).map((mark) => (
                        <button
                          type="button"
                          key={mark}
                          aria-label={mark}
                          aria-pressed={marks.includes(mark)}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => format(mark)}
                        >
                          {mark === "bold" ? <b>B</b> : mark === "italic" ? <i>I</i> : <u>U</u>}
                          <span
                            className="content-control-tooltip"
                            role="tooltip"
                          >{`${mark[0]!.toUpperCase()}${mark.slice(1)} (Ctrl/⌘+${mark === "bold" ? "B" : mark === "italic" ? "I" : "U"})`}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {error && (
              <p className="content-error" role="alert" tabIndex={-1} ref={alert}>
                {error}
              </p>
            )}
          </div>
        </div>
        <footer className="asset-picker-actions">
          <button
            type="submit"
            className="ui-button pill-button asset-picker-add"
            disabled={
              component && "assetId" in component
                ? !media.some(
                    (item) => item.id === component.assetId && item.kind === component.type,
                  )
                : !component &&
                  ["audio", "video", "image"].includes(kind) &&
                  !((before as Partial<ContentObject>).components ?? []).some(
                    (item) => item.type === kind,
                  )
            }
          >
            {kind === "text" &&
            (before as Partial<ContentObject>).components?.some((item) => item.type === "text")
              ? "Update"
              : "Add"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
