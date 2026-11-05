import { ColorSwatches } from "./ColorSwatches";
import { useEffect, useRef, useState } from "react";
import type { ContentObject } from "../../shared/project/project-content";
import type { SceneObject } from "../../shared/project/scene-object";
import {
  defaultAppearance,
  exhibitMaterials,
  type ExhibitAppearance,
} from "../../shared/project/project-appearance";
import type { ValidationResult } from "../../shared/project/validation-helpers";
import type { ContentKind } from "./ContentEditor";
import { Icon } from "./Icon";
import "./exhibit-popups.css";

export function ExhibitPopups({
  object,
  anchor,
  displayRole,
  onEdit,
  onLibrary,
  onRemoveContent,
  onRemoveMedia,
  onRemoveText,
  onConfirm,
}: {
  object: SceneObject;
  anchor: () => { left: number; right: number; top: number; bottom: number } | null;
  displayRole: "digital" | "physical" | undefined;
  onEdit: (kind: ContentKind) => void;
  onLibrary: () => void;
  onRemoveContent?: (() => void) | undefined;
  onRemoveMedia?: (() => void) | undefined;
  onRemoveText?: (() => void) | undefined;
  onConfirm: (appearance: ExhibitAppearance) => ValidationResult<true>;
}) {
  const media = (object as Partial<ContentObject>).components?.find(
    (component) => component.type === "image" || component.type === "video",
  );
  const element = useRef<HTMLDivElement>(null);
  const appearance = (object as Partial<ContentObject>).appearance ?? defaultAppearance;
  const [popup, setPopup] = useState<"color" | "material" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let frame: number;
    function position() {
      const box = anchor();
      const target = element.current;
      if (target) {
        target.hidden = box === null;
        if (box) {
          const half = target.offsetWidth / 2;
          target.style.left = `${Math.max(half + 12, Math.min(innerWidth - half - 12, (box.left + box.right) / 2))}px`;
          target.style.top = `${Math.max(target.offsetHeight + 100, box.top - 16)}px`;
        }
      }
      frame = requestAnimationFrame(position);
    }
    position();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);
  useEffect(() => {
    if (!popup) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !element.current?.contains(event.target)) setPopup(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setPopup(null);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [popup]);
  function change(next: ExhibitAppearance) {
    const result = onConfirm(next);
    setError(result.ok ? "" : result.error.message);
  }
  if (!displayRole) return null;
  return (
    <div className="exhibit-context" ref={element} aria-label={`Edit ${object.name}`}>
      {popup && (
        <section
          className={`exhibit-swatches is-${popup}${popup === "color" ? " color-palette" : ""}`}
          role="dialog"
          aria-label={popup === "color" ? "Display colour" : "Display texture"}
        >
          <div className={popup === "color" ? undefined : "exhibit-swatch-grid"}>
            {popup === "color" ? (
              <ColorSwatches
                value={appearance.color}
                onChange={(color) => change({ ...appearance, color })}
              />
            ) : (
              exhibitMaterials.map((material) => (
                <button
                  key={material}
                  type="button"
                  className={`swatch-${material}`}
                  aria-label={`${material} texture`}
                  aria-pressed={appearance.material === material}
                  title={material[0]!.toUpperCase() + material.slice(1)}
                  onClick={() => change({ ...appearance, material })}
                />
              ))
            )}
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <div className="exhibit-popup-toolbar" role="group" aria-label="Exhibit popup controls">
        {displayRole && (
          <>
            <button
              type="button"
              aria-label="Display texture"
              aria-expanded={popup === "material"}
              onClick={() => setPopup(popup === "material" ? null : "material")}
            >
              <span className="exhibit-texture-icon" aria-hidden="true" />
              <span className="exhibit-tooltip" role="tooltip">
                Texture
              </span>
            </button>
            <button
              type="button"
              aria-label="Display colour"
              aria-expanded={popup === "color"}
              onClick={() => setPopup(popup === "color" ? null : "color")}
            >
              <span
                className="exhibit-colour-icon"
                style={{ background: appearance.color }}
                aria-hidden="true"
              />
              <span className="exhibit-tooltip" role="tooltip">
                Colour
              </span>
            </button>
            <span className="toolbar-divider" />
          </>
        )}
        {displayRole === "physical" && (
          <button type="button" aria-label="Display asset library" onClick={onLibrary}>
            <Icon name="library" />
            <span className="exhibit-tooltip" role="tooltip">
              Asset library
            </span>
          </button>
        )}
        {(["text", "video", "image"] as const)
          .filter(
            (kind) => displayRole === "digital" || (displayRole === "physical" && kind === "text"),
          )
          .map((kind) => (
            <button
              key={kind}
              type="button"
              aria-label={`Edit ${kind}`}
              disabled={kind === "text" && !!media}
              title={
                kind === "text" && media
                  ? "Remove the image or video before adding text"
                  : undefined
              }
              onClick={() => onEdit(kind)}
            >
              <Icon name={kind} />
              <span className="exhibit-tooltip" role="tooltip">
                {kind === "text" ? "Text" : kind === "image" ? "Image" : "Video"}
              </span>
            </button>
          ))}
        {(object as Partial<ContentObject>).components?.some(
          (component) => component.type === "text",
        ) &&
          onRemoveText && (
            <button type="button" aria-label="Remove text" onClick={onRemoveText}>
              <span className="exhibit-remove-media-icon">
                <Icon name="text" />
                <span className="exhibit-remove-badge" aria-hidden="true">
                  <svg viewBox="0 0 12 12" width="12" height="12">
                    <path
                      d="m3.5 3.5 5 5m0-5-5 5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </span>
              <span className="exhibit-tooltip" role="tooltip">
                Remove text
              </span>
            </button>
          )}
        {media && onRemoveMedia && (
          <button
            type="button"
            aria-label={media.type === "video" ? "Remove video" : "Remove image"}
            onClick={onRemoveMedia}
          >
            <span className="exhibit-remove-media-icon">
              <Icon name={media.type === "video" ? "video" : "image"} />
              <span className="exhibit-remove-badge" aria-hidden="true">
                <svg viewBox="0 0 12 12" width="12" height="12">
                  <path
                    d="m3.5 3.5 5 5m0-5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </span>
            <span className="exhibit-tooltip" role="tooltip">
              {media.type === "video" ? "Remove video" : "Remove image"}
            </span>
          </button>
        )}
        {onRemoveContent && (
          <button type="button" aria-label="Remove displayed object" onClick={onRemoveContent}>
            <Icon name="removeDisplayObject" />
            <span className="exhibit-tooltip" role="tooltip">
              Remove displayed object
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
