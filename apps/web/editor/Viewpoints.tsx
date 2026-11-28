import { Icon as EditorIcon } from "./ui/Icon";
import { Button } from "../shared/ui/Button";
import "./saved-views.css";
import { Icon } from "@iconify/react/offline";
import trashIcon from "@iconify-icons/ant-design/delete-outlined";
import { getStartingView } from "../shared/project/starting-view";
import { useEffect, useState } from "react";
import type { NamedViewpoint, CameraPose } from "../shared/project/project-types";
import { playUiSound } from "./audio/ui-sounds";
import type { createDocumentStore } from "./document-store";
import type { ViewpointCamera } from "./viewport/Viewport";

export function Viewpoints({
  views,
  startCamera,
  camera,
  disabled,
  store,
}: {
  views: readonly NamedViewpoint[];
  startCamera: CameraPose;
  camera: ViewpointCamera | null;
  disabled: boolean;
  store: ReturnType<typeof createDocumentStore>;
}) {
  useEffect(() => {
    if (!disabled && camera) store.initializeDefaultViewpoint();
  }, [disabled, camera, store]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const view = views.find((entry) => entry.id === selected);
  const deletingView = views.find((entry) => entry.id === deleting);
  const startingView = getStartingView({ viewpoints: views, startCamera });
  function report(result: ReturnType<typeof store.deleteViewpoint>, success: string) {
    setMessage(result.ok ? success : result.error.message);
    setError(!result.ok);
  }
  function clearDrag() {
    setDragged(null);
    setDrop(null);
  }
  function move(id: string, index: number) {
    if (!disabled && camera)
      report(store.moveViewpoint(id, index), "View order updated. Undo is available.");
  }
  function rename(entry: NamedViewpoint, value: string) {
    if (disabled || !camera) return;
    const result = store.renameViewpoint(entry.id, value);
    report(result, "View renamed. Undo is available.");
    if (result.ok) setEditing(null);
  }
  return (
    <section className="saved-views-panel" aria-label="Named viewpoints">
      <p className="saved-views-description">Frame the view, give it a name, capture it.</p>
      <fieldset disabled={disabled || !camera}>
        {views.length === 0 && <p className="saved-views-empty">No saved views yet.</p>}
        <ol aria-label="Saved views in order">
          {views.map((entry, index) => (
            <li
              key={entry.id}
              className={drop?.id === entry.id ? (drop.after ? "drop-after" : "drop-before") : ""}
              onDragOver={(event) => {
                if (!dragged || disabled || !camera) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                setDrop({ id: entry.id, after: event.clientY >= bounds.top + bounds.height / 2 });
              }}
              onDragLeave={() => setDrop(null)}
              onDrop={(event) => {
                event.preventDefault();
                const from = views.findIndex((v) => v.id === dragged);
                if (from >= 0 && dragged && !disabled && camera) {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const slot = index + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
                  move(dragged, slot > from ? slot - 1 : slot);
                }
                clearDrag();
              }}
            >
              <Button
                variant="quiet"
                type="button"
                className="saved-view-grip"
                aria-label={`Reorder ${entry.name}`}
                title="Drag to reorder; use arrow keys to move"
                draggable={!disabled && !!camera}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  const next = index + (event.key === "ArrowUp" ? -1 : 1);
                  if (next >= 0 && next < views.length) move(entry.id, next);
                }}
                onDragStart={(event) => {
                  if (disabled || !camera) {
                    event.preventDefault();
                    return;
                  }
                  setDragged(entry.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-spatia-viewpoint", entry.id);
                }}
                onDragEnd={clearDrag}
              >
                <EditorIcon name="dragHandle" />
              </Button>
              <div className="saved-view-card" data-selected={selected === entry.id}>
                {editing === entry.id ? (
                  <label className="saved-view-name-edit">
                    <span>{index + 1}.</span>
                    <input
                      className="tree-rename"
                      aria-label="View name"
                      autoFocus
                      maxLength={120}
                      value={name}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setName(event.target.value)}
                      onBlur={(event) => rename(entry, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(null);
                          setName(entry.name);
                        }
                      }}
                    />
                  </label>
                ) : (
                  <button
                    type="button"
                    className="saved-view-name"
                    aria-pressed={selected === entry.id}
                    title="Double-click to rename; press F2 to rename"
                    onClick={() => {
                      setSelected(entry.id);
                      setDeleting(null);
                    }}
                    onDoubleClick={() => {
                      setName(entry.name);
                      setEditing(entry.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        setName(entry.name);
                        setEditing(entry.id);
                      }
                    }}
                  >
                    {index + 1}. {entry.name}
                  </button>
                )}
                <Button
                  variant="quiet"
                  type="button"
                  className="saved-view-delete"
                  aria-label={`Delete view ${entry.name}`}
                  title="Delete view"
                  onClick={() => {
                    setSelected(entry.id);
                    setEditing(null);
                    setDeleting(entry.id);
                  }}
                >
                  <Icon icon={trashIcon} className="icon" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {view && !deletingView && (
          <div className="saved-view-actions">
            <button
              type="button"
              disabled={editing !== null}
              onClick={() => camera?.show(view.camera)}
            >
              Go to view
            </button>
            <button
              type="button"
              disabled={editing !== null || view.id === startingView?.id}
              onClick={() =>
                report(
                  store.setStartingViewpoint(view.id),
                  "Starting view saved. Undo is available.",
                )
              }
            >
              Set as starting view
            </button>
          </div>
        )}
        {!deletingView && (
          <button
            type="button"
            className="saved-view-add"
            onClick={() => {
              if (camera) {
                let number = views.length + 1;
                const names = new Set(views.map((entry) => entry.name));
                while (names.has(`View ${number}`)) number++;
                report(
                  store.addViewpoint(`View ${number}`, camera.capture()),
                  "View captured. Undo is available.",
                );
              }
            }}
          >
            + Add View
          </button>
        )}
        {deletingView && (
          <div className="saved-view-confirm" role="group" aria-label="Confirm view deletion">
            <h3>Delete “{deletingView.name}”?</h3>
            <p>
              Associated navigation points and rules will also be deleted. Undo restores them all.
            </p>
            <div className="saved-view-confirm-actions">
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="saved-view-confirm-delete"
                aria-label="Confirm delete view"
                onClick={() => {
                  const result = store.deleteViewpoint(deletingView.id);
                  if (result.ok) {
                    setDeleting(null);
                    playUiSound("delete");
                  }
                  report(
                    result,
                    "View, associated navigation points and rules deleted. Undo restores them all.",
                  );
                }}
              >
                Delete view
              </button>
            </div>
          </div>
        )}
      </fieldset>
      <p className={error ? "saved-views-status" : "sr-only"} role="status">
        {message}
      </p>
    </section>
  );
}
