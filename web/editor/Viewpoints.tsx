import { getStartingView } from "../shared/project/starting-view";
import { useState } from "react";
import type { NamedViewpoint } from "../shared/project/project-types";
import type { createDocumentStore } from "./document-store";
import type { ViewpointCamera } from "./viewport/Viewport";

export function Viewpoints({
  views,
  startViewpointId,
  camera,
  disabled,
  store,
}: {
  views: readonly NamedViewpoint[];
  startViewpointId: string | undefined;
  camera: ViewpointCamera | null;
  disabled: boolean;
  store: ReturnType<typeof createDocumentStore>;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  function clearDrag() {
    setDragged(null);
    setDrop(null);
  }
  function move(id: string, index: number) {
    if (disabled || !camera) return;
    report(store.moveViewpoint(id, index), "View order updated. Undo is available.");
  }
  const view = views.find((v) => v.id === selected);
  const startingView = getStartingView({
    viewpoints: views,
    ...(startViewpointId ? { startViewpointId } : {}),
  });
  function cycleView(direction: -1 | 1) {
    if (disabled || !camera || views.length === 0) return;
    const current = views.findIndex((entry) => entry.id === selected);
    // Start at the first/last view if none is selected, then wrap at either end.
    const index =
      current < 0
        ? direction === 1
          ? 0
          : views.length - 1
        : (current + direction + views.length) % views.length;
    const next = views[index]!;
    setSelected(next.id);
    setName(next.name);
    camera.show(next.camera);
    setMessage(`Showing ${next.name}, view ${index + 1} of ${views.length}.`);
  }
  function report(result: ReturnType<typeof store.deleteViewpoint>, success: string) {
    setMessage(result.ok ? success : result.error.message);
  }
  return (
    <section className="viewpoints" aria-label="Named viewpoints">
      <h2>Saved views</h2>
      <p>Frame the view, give it a name, then capture it.</p>
      <p>
        Starting view: {startingView?.name ?? "Saved scene camera"}
        {startingView && !startViewpointId ? " (first saved view)" : ""}
      </p>
      <fieldset disabled={disabled || !camera}>
        <label>
          View name
          <input maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => {
            if (camera)
              report(
                store.addViewpoint(name, camera.capture()),
                "View captured. Undo is available.",
              );
          }}
        >
          Capture current view
        </button>
        <div
          className="saved-view-picker"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              clearDrag();
              setOpen(false);
            }
          }}
        >
          <button
            type="button"
            className="saved-view-toggle"
            aria-expanded={open}
            aria-controls="saved-view-list"
            onClick={() => {
              clearDrag();
              setOpen(!open);
            }}
          >
            {view?.name ?? "Choose a saved view"} {open ? "\u25b4" : "\u25be"}
          </button>
          {open && (
            <div id="saved-view-list" className="saved-view-menu">
              <p>Drag the handles to change the order, or select a view and use Move up/down.</p>
              {views.length === 0 && <p>No saved views yet.</p>}
              <ol
                aria-label="Saved views in order"
                onDragLeave={(e) => {
                  if (
                    !(e.relatedTarget instanceof Node) ||
                    !e.currentTarget.contains(e.relatedTarget)
                  )
                    setDrop(null);
                }}
              >
                {views.map((entry, index) => (
                  <li
                    key={entry.id}
                    className={
                      drop?.id === entry.id ? (drop.after ? "drop-after" : "drop-before") : ""
                    }
                    onDragOver={(e) => {
                      if (!dragged || disabled || !camera) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const bounds = e.currentTarget.getBoundingClientRect();
                      setDrop({ id: entry.id, after: e.clientY >= bounds.top + bounds.height / 2 });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = views.findIndex((v) => v.id === dragged);
                      if (from >= 0 && dragged && !disabled && camera) {
                        const bounds = e.currentTarget.getBoundingClientRect();
                        const slot = index + (e.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
                        move(dragged, slot > from ? slot - 1 : slot);
                      }
                      clearDrag();
                    }}
                  >
                    <span
                      className="view-drag-handle"
                      draggable={!disabled && !!camera}
                      title={`Drag to reorder ${entry.name}`}
                      aria-hidden="true"
                      onDragStart={(e) => {
                        if (disabled || !camera) {
                          e.preventDefault();
                          return;
                        }
                        setDragged(entry.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("application/x-spatia-viewpoint", entry.id);
                      }}
                      onDragEnd={clearDrag}
                    >
                      {"\u283f"}
                    </span>
                    <button
                      type="button"
                      aria-pressed={selected === entry.id}
                      onClick={() => {
                        setSelected(entry.id);
                        setName(entry.name);
                      }}
                    >
                      {index + 1}. {entry.name}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="viewpoint-actions">
                <button
                  type="button"
                  disabled={!view || views.indexOf(view) === 0}
                  onClick={() => {
                    if (view) move(view.id, views.indexOf(view) - 1);
                  }}
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={!view || views.indexOf(view) === views.length - 1}
                  onClick={() => {
                    if (view) move(view.id, views.indexOf(view) + 1);
                  }}
                >
                  Move down
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="viewpoint-cycle" role="group" aria-label="Browse saved views">
          <button
            type="button"
            aria-label="Previous saved view"
            disabled={views.length === 0}
            onClick={() => cycleView(-1)}
          >
            {"\u2190"}
          </button>
          <span aria-live="polite">
            {view ? `${views.indexOf(view) + 1} / ${views.length}` : `${views.length} saved`}
          </span>
          <button
            type="button"
            aria-label="Next saved view"
            disabled={views.length === 0}
            onClick={() => cycleView(1)}
          >
            {"\u2192"}
          </button>
        </div>
        <div className="viewpoint-actions">
          <button
            type="button"
            disabled={!view}
            onClick={() => {
              if (view) camera?.show(view.camera);
            }}
          >
            Go to view
          </button>
          <button
            type="button"
            disabled={!view || view.id === startViewpointId}
            onClick={() => {
              if (view)
                report(
                  store.setStartingViewpoint(view.id),
                  "Starting view saved. Undo is available.",
                );
            }}
          >
            Set as starting view
          </button>
          <button
            type="button"
            disabled={!view || !name.trim()}
            onClick={() => {
              if (view) report(store.renameViewpoint(view.id, name), "View renamed.");
            }}
          >
            Rename
          </button>
          <button
            type="button"
            disabled={!view}
            onClick={() => {
              if (view) report(store.deleteViewpoint(view.id), "View deleted. Undo restores it.");
            }}
          >
            Delete view
          </button>
        </div>
      </fieldset>
      <p role="status">{message}</p>
    </section>
  );
}
