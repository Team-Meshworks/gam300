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
