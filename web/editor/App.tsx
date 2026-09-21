import { useEffect, useState, useSyncExternalStore } from "react";
import { assetDragType, sampleAsset } from "../shared/assets/sample-asset";
import type { Vector3Tuple } from "../shared/project/scene-object";
import { createDocumentStore } from "./document-store";
import type { ViewportStatus } from "./graphics/scene";
import { Viewport } from "./viewport/Viewport";

export function App() {
  const [store] = useState(createDocumentStore);
  const { objects, canUndo, canRedo } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string>();
  const [status, setStatus] = useState<ViewportStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const selection = objects.some((object) => object.id === selectedId) ? selectedId : null;
  const hasChanges = objects.length > 0;

  useEffect(() => {
    if (!hasChanges) {
      return;
    }
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    addEventListener("beforeunload", warnBeforeLeaving);
    return () => removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasChanges]);

  function place(position: Vector3Tuple) {
    const result = store.addObject(position);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    setNotice(`Added ${result.object.name}.`);
  }

  return (
    <div className="editor-shell">
      <a className="skip-link" href="#viewport">
        Skip to scene
      </a>
      <header className="app-header">
        <h1>
          <strong>VThere</strong> Spatial Experience Editor
        </h1>
        <div className="history-controls" role="group" aria-label="History">
          <button type="button" disabled={!canUndo} onClick={store.undo}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" />
            </svg>
            Undo
          </button>
          <button type="button" disabled={!canRedo} onClick={store.redo}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />
            </svg>
            Redo
          </button>
        </div>
        {hasChanges && (
          <span className="save-state" title="Changes last until you close or reload this page.">
            Not saved
          </span>
        )}
      </header>

      <main className="workspace">
        <aside className="library" aria-label="Assets and scene objects">
          <section aria-labelledby="assets-heading">
            <h2 id="assets-heading">Asset library</h2>
            <ul className="asset-shelf" role="list">
              <li>
                <button
                  className="asset-tile"
                  type="button"
                  draggable={status === "ready"}
                  disabled={status !== "ready"}
                  aria-label={`Add ${sampleAsset.name}`}
                  title="Drag into the scene, or click to add"
                  onClick={() => place([0, 0, 0])}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(assetDragType, sampleAsset.id);
                    event.dataTransfer.effectAllowed = "copy";
                    setDragging(true);
                  }}
                  onDragEnd={() => setDragging(false)}
                >
                  <span className="asset-art">
                    {thumbnail && <img src={thumbnail} alt="" draggable={false} />}
                    <span className="asset-add" aria-hidden="true">
                      +
                    </span>
                  </span>
                  <span className="asset-name">{sampleAsset.name}</span>
                </button>
              </li>
            </ul>
          </section>

          {hasChanges && (
            <section className="scene-objects" aria-labelledby="objects-heading">
              <h2 id="objects-heading">
                In this scene <span>{objects.length}</span>
              </h2>
              <ul role="list">
                {objects.map((object) => (
                  <li key={object.id}>
                    <button
                      className="object-row"
                      type="button"
                      aria-pressed={selection === object.id}
                      data-object-id={object.id}
                      onClick={() => setSelectedId(object.id)}
                    >
                      <img src={thumbnail} alt="" draggable={false} />
                      <span>{object.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <Viewport
          objects={objects}
          selectedId={selection}
          dragging={dragging}
          status={status}
          attempt={attempt}
          onStatus={setStatus}
          onThumbnail={setThumbnail}
          onSelect={setSelectedId}
          onPlace={place}
          onDragFinish={() => setDragging(false)}
          onRetry={() => {
            setStatus("loading");
            setAttempt((previous) => previous + 1);
          }}
        />
      </main>
      <p className="sr-only" role="status">
        {notice}
      </p>
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
