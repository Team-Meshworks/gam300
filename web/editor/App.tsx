import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assets } from "virtual:asset-catalogue";
import { assetDragType } from "../shared/assets/catalogue";
import type { Vector3Tuple } from "../shared/project/scene-object";
import type { Transform } from "../shared/project/project-types";
import { createDocumentStore } from "./document-store";
import {
  handleHistoryShortcut,
  handleObjectShortcut,
  isTextEditingTarget,
} from "./history-shortcuts";
import type { ViewportStatus } from "./graphics/scene";
import type { ModeManager, ModeManagerState } from "./graphics/modeManager";
import { Viewport } from "./viewport/Viewport";
import sampleProject from "../shared/project/fixtures/m1-project.json";

import { ProjectConfirmation } from "./ProjectConfirmation";
import { useProjectSession } from "./persistence/use-project-session";

// Same catalog used by the viewport; saved references need to resolve here too
const assetKinds = new Map(assets.map((asset) => [asset.id, asset.kind]));

export function App() {
  const [store] = useState(() => createDocumentStore(assets));
  const { objects, project, canUndo, canRedo } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generatedThumbnails, setGeneratedThumbnails] = useState<Record<string, string>>({});
  const onThumbnail = useCallback((id: string, url: string) => {
    setGeneratedThumbnails((previous) => ({ ...previous, [id]: url }));
  }, []);
  const thumbnailFor = (id: string) =>
    assets.find((asset) => asset.id === id)?.thumbnail ?? generatedThumbnails[id];
  const [status, setStatus] = useState<ViewportStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState({ text: "", sequence: 0 });
  const notice = feedback.text;
  const [error, setError] = useState("");
  const setNotice = useCallback((text: string) => {
    // Every new message gets its own fade, even when the text repeats
    setFeedback((previous) => ({ text, sequence: previous.sequence + 1 }));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFeedback((previous) => (previous.text ? { ...previous, text: "" } : previous));
    }, 3500);
    return () => clearTimeout(timer);
  }, [feedback.sequence]);
  const draftMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Clicking back into the editor closes the project options
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !draftMenu.current?.contains(event.target)) {
        draftMenu.current?.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, []);
  function closeDraftMenu() {
    draftMenu.current?.removeAttribute("open");
    draftMenu.current?.querySelector("summary")?.focus();
  }
  const [manager, setManager] = useState<ModeManager | null>(null);
  const [modeState, setModeState] = useState<ModeManagerState | null>(null);
  const selection = objects.some((object) => object.id === selectedId) ? selectedId : null;
  const projectScene = project?.scenes[0];
  const roomAsset = assets.find((asset) => asset.id === projectScene?.environmentAssetId);
  // Room selection uses the scene ID because its asset lives in the environment field
  // Object commands still receive only placed-object IDs
  const roomSelected = projectScene !== undefined && selectedId === projectScene.id;
  const [hasDeleted, setHasDeleted] = useState(false);
  const selectedObject = objects.find((object) => object.id === selection);
  const hasChanges = project !== null || objects.length > 0 || hasDeleted;
  const visitor = modeState?.mode === "visitor";

  const onManager = useCallback((next: ModeManager) => {
    setManager(next);
    setModeState(next.getState());
  }, []);

  useEffect(() => (manager === null ? undefined : manager.subscribe(setModeState)), [manager]);

  const onReplace = useCallback(() => {
    setSelectedId(null);
    setDragging(false);
    setError("");
    setHasDeleted(false);
  }, []);
  const session = useProjectSession(store, assets, project, objects.length, onReplace, setNotice);
  const storageOperation = session.operation;
  const switching =
    storageOperation === "switch" ||
    storageOperation === "recover" ||
    storageOperation === "import";

  useEffect(() => {
    function onHistoryKeyDown(event: KeyboardEvent) {
      // A project confirmation owns the keyboard until the author makes a choice.
      if (session.busy || visitor) return;
      const editingText = event.composedPath().some(isTextEditingTarget);
      handleHistoryShortcut(event, store, editingText);
      handleObjectShortcut(
        event,
        {
          copy() {
            if (selection === null) {
              setError("Select an object to copy.");
              return;
            }
            const result = store.copyObject(selection);
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            setError("");
            setNotice(`Copied ${result.value.name}. Press Ctrl+V to paste.`);
          },
          paste() {
            const result = store.pasteObject();
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            setSelectedId(result.value.id);
            setError("");
            setNotice(`Pasted ${result.value.name}. Undo is available.`);
          },
          duplicate() {
            if (selection === null) {
              setError("Select an object to duplicate.");
              return;
            }
            const result = store.duplicateObject(selection);
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            setSelectedId(result.value.id);
            setError("");
            setNotice(`Duplicated ${result.value.name}. Undo is available.`);
          },
        },
        editingText,
      );
    }
    window.addEventListener("keydown", onHistoryKeyDown);
    return () => window.removeEventListener("keydown", onHistoryKeyDown);
  }, [store, selection, session.busy, visitor, setNotice]);

  useEffect(() => {
    // Filename identifies the browser tab; save status stays in the editor
    document.title = `${session.fileName || "Untitled"} - VThere`;
  }, [session.fileName]);

  // Keep keyboard saving on the same path as the menu and its file picker
  useEffect(() => {
    function saveShortcut(event: KeyboardEvent) {
      if (visitor || event.defaultPrevented || event.isComposing || event.altKey) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        document.getElementById(event.shiftKey ? "project-save-as" : "project-save")?.click();
      }
    }
    addEventListener("keydown", saveShortcut);
    return () => removeEventListener("keydown", saveShortcut);
  }, [visitor]);

  const onTransform = useCallback(
    (id: string, transform: Transform) => {
      const result = store.setTransform(id, transform);
      if (!result.ok) {
        setError(result.error);
      } else if (result.changed) {
        setError("");
        setNotice("Moved object. Undo is available.");
      }
    },
    [store, setNotice],
  );

  function moveSelected(axis: 0 | 1 | 2, delta: number) {
    if (visitor || selectedObject === undefined) return;
    const position = [...selectedObject.transform.position] as [number, number, number];
    position[axis] += delta;
    onTransform(selectedObject.id, { ...selectedObject.transform, position });
  }

  function place(assetId: string, position: Vector3Tuple) {
    if (visitor) return;
    session.clearError();
    // Choosing the first room turns the grid scene into a saveable project
    // Room placement uses the environment slot so it survives JSON reconstruction
    if (assetKinds.get(assetId) === "environment") {
      if (session.busy) {
        setNotice("Wait for the project to finish opening, then choose a room");
        return;
      }
      // The library keeps the room available after placement
      // Dropping the current room again leaves the scene and undo history alone
      if (store.getSnapshot().project?.scenes[0]?.environmentAssetId === assetId) {
        setDragging(false);
        setNotice("This room is already in the scene");
        return;
      }
      const created = store.createProject(assetId);
      if (!created.ok) {
        setError(created.error.message);
        return;
      }
      setError("");
      setDragging(false);
      if (created.value.scenes[0]?.objects.length === 0) session.markPristine(created.value);
      setNotice("Project created; choose Save to name its file");
      return;
    }
    const result = store.addObject(assetId, position);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    setNotice(`Added ${result.object.name}`);
  }

  function deleteSelection() {
    if (selection === null || visitor) return;
    const result = store.deleteObject(selection);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError("");
    setHasDeleted(true);
    setSelectedId(null);
    setNotice(`Deleted ${result.value.name}. Undo restores it.`);
  }

  return (
    <div className="editor-shell">
      <a className="skip-link" href="#viewport">
        Skip to scene
      </a>
      <header className="app-header">
        {/* Project actions stay behind this icon so the library has room for assets */}
        <details
          className="draft-menu"
          inert={visitor}
          ref={draftMenu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeDraftMenu();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              event.currentTarget.removeAttribute("open");
          }}
        >
          <summary aria-label="Project options" title="Project options">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </summary>
          <div className="draft-menu-panel">
            <button
              type="button"
              title="Start a new project with an empty room"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void session.createNew();
              }}
            >
              New
            </button>
            <button
              type="button"
              title="Open a JSON project file"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void session.open();
              }}
            >
              Open
            </button>
            <button
              id="project-save"
              type="button"
              title={
                project === null
                  ? "Choose a room to create your project"
                  : "Save changes to the current file · Ctrl+S"
              }
              disabled={project === null || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void session.save();
              }}
            >
              Save
            </button>
            <button
              id="project-save-as"
              type="button"
              title={
                project === null
                  ? "Choose a room to create your project"
                  : "Choose a filename and folder · Ctrl+Shift+S"
              }
              disabled={project === null || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void session.save(true);
              }}
            >
              Save As
            </button>
          </div>
        </details>
        <h1>
          <strong>VThere</strong> Spatial Experience Editor
        </h1>
        <div
          className="history-controls"
          role="group"
          aria-label="History"
          inert={visitor || switching}
        >
          <button type="button" disabled={selection === null || visitor} onClick={deleteSelection}>
            Delete selected
          </button>
          {import.meta.env.DEV && (
            <button
              type="button"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={() => void session.openSample(sampleProject)}
            >
              Open sample project
            </button>
          )}
          <button
            type="button"
            disabled={!canUndo}
            onClick={store.undo}
            title="Undo (Ctrl+Z / ⌘Z)"
            aria-keyshortcuts="Control+z Meta+z"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" />
            </svg>
            Undo
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={store.redo}
            title="Redo (Ctrl+Y / Ctrl+Shift+Z / ⌘⇧Z)"
            aria-keyshortcuts="Control+y Control+Shift+z Meta+Shift+z"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />
            </svg>
            Redo
          </button>
        </div>
        {manager !== null && (
          <div className="mode-actions" role="group" aria-label="Camera mode">
            {visitor ? (
              <button type="button" onClick={() => manager.setMode("editor")}>
                Exit Visitor
              </button>
            ) : (
              <button
                type="button"
                disabled={session.busy}
                onClick={() => {
                  manager.setMode("visitor");
                  document.getElementById("viewport")?.focus();
                }}
              >
                Enter Visitor
              </button>
            )}
          </div>
        )}
        {hasChanges && (
          <div className="project-file-status">
            {/* Recovery stays quiet; this status only describes the manual JSON save */}
            <span
              className="save-state"
              data-state={
                storageOperation === "file"
                  ? "saving"
                  : session.fileFailed
                    ? "failed"
                    : session.dirty
                      ? "pending"
                      : "saved"
              }
              title={
                session.dirty
                  ? "Changes have not been saved to the JSON file"
                  : "Project matches the last opened or saved JSON file"
              }
              role="status"
            >
              {storageOperation === "file"
                ? "Saving…"
                : session.fileFailed
                  ? "Save failed"
                  : session.dirty
                    ? "Not saved"
                    : "Saved"}
            </span>
          </div>
        )}
      </header>
      {/* Reset the input so choosing the same file again still fires a change */}
      <input
        id="project-import"
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) void session.importFile(file);
        }}
      />

      <main className="workspace" inert={switching}>
        <aside className="library" aria-label="Assets and scene objects" inert={visitor}>
          <section aria-labelledby="assets-heading">
            <h2 id="assets-heading">Asset library</h2>
            <ul className="asset-shelf" role="list">
              {/* Keep the full library visible when a project is open */}
              {assets.map((asset) => (
                <li key={asset.id}>
                  <button
                    className="asset-tile"
                    type="button"
                    draggable={status === "ready"}
                    disabled={status !== "ready"}
                    aria-label={`Add ${asset.name}`}
                    title="Drag into the scene, or click to add"
                    onClick={() => place(asset.id, [0, 0, 0])}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(assetDragType, asset.id);
                      event.dataTransfer.effectAllowed = "copy";
                      setDragging(true);
                    }}
                    onDragEnd={() => setDragging(false)}
                  >
                    <span className="asset-art">
                      <img src={thumbnailFor(asset.id)} alt="" draggable={false} />
                      <span className="asset-add" aria-hidden="true">
                        +
                      </span>
                    </span>
                    <span className="asset-name">{asset.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {hasChanges && (
            <section className="scene-objects" aria-labelledby="objects-heading">
              <h2 id="objects-heading">
                In this scene <span>{objects.length + (projectScene === undefined ? 0 : 1)}</span>
              </h2>
              <ul role="list">
                {projectScene !== undefined && (
                  <li key={projectScene.id}>
                    <button
                      className="environment-row"
                      type="button"
                      aria-pressed={roomSelected}
                      onClick={() => setSelectedId(projectScene.id)}
                    >
                      <img
                        src={thumbnailFor(projectScene.environmentAssetId)}
                        alt=""
                        draggable={false}
                      />
                      <span>{roomAsset?.name ?? projectScene.name}</span>
                    </button>
                  </li>
                )}
                {objects.map((object) => (
                  <li key={object.id}>
                    <button
                      className="object-row"
                      type="button"
                      aria-pressed={selection === object.id}
                      data-object-id={object.id}
                      onClick={() => setSelectedId(object.id)}
                    >
                      <img src={thumbnailFor(object.assetId)} alt="" draggable={false} />
                      <span>{object.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {selectedObject !== undefined && (
                <div
                  className="move-controls"
                  role="group"
                  aria-label={`Move ${selectedObject.name}`}
                >
                  <p>Move selected · 0.25 m per step</p>
                  <div>
                    {([0, 1, 2] as const).map((axis) =>
                      ([-0.25, 0.25] as const).map((delta) => (
                        <button
                          key={`${axis}:${delta}`}
                          type="button"
                          aria-label={`Move ${selectedObject.name} ${"XYZ"[axis]} ${delta > 0 ? "plus" : "minus"} 0.25 metres`}
                          onClick={() => moveSelected(axis, delta)}
                        >
                          {"XYZ"[axis]} {delta > 0 ? "+" : "−"}
                        </button>
                      )),
                    )}
                  </div>
                  <output aria-label="Selected position">
                    {selectedObject.transform.position
                      .map((value, axis) => `${"XYZ"[axis]} ${value.toFixed(2)}`)
                      .join(" · ")}{" "}
                    m
                  </output>
                </div>
              )}
            </section>
          )}
        </aside>

        <Viewport
          assets={assets}
          objects={objects}
          projectScene={project?.scenes[0] ?? null}
          selectedId={roomSelected ? projectScene.id : selection}
          dragging={dragging}
          editingEnabled={!switching}
          status={status}
          attempt={attempt}
          onStatus={setStatus}
          onThumbnail={onThumbnail}
          onSelect={setSelectedId}
          onTransform={onTransform}
          onPlace={place}
          onDragFinish={() => setDragging(false)}
          onRetry={() => {
            setStatus("loading");
            setAttempt((previous) => previous + 1);
          }}
          onManager={onManager}
        />
      </main>
      <p
        key={`${storageOperation === "recover" || storageOperation === "import" ? storageOperation : "notice"}-${feedback.sequence}`}
        className="draft-feedback"
        role="status"
      >
        {storageOperation === "recover"
          ? "Reopening saved work…"
          : storageOperation === "import"
            ? "Reading project file…"
            : notice}
      </p>
      {session.confirmation && (
        <ProjectConfirmation
          fileName={session.fileName || "Untitled"}
          busy={session.deciding}
          onChoice={session.answer}
        />
      )}
      {(session.error || error) && (
        <p
          key={session.error || error}
          className="action-error"
          role="alert"
          onAnimationEnd={() => {
            session.clearError();
            setError("");
          }}
        >
          {session.error || error}
        </p>
      )}
    </div>
  );
}
