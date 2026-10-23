import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { assets } from "virtual:asset-catalogue";
import type { Vector3Tuple } from "../shared/project/scene-object";
import type { Transform } from "../shared/project/project-types";
import { createDocumentStore } from "./document-store";
import {
  handleDeleteShortcut,
  handleHistoryShortcut,
  handleObjectShortcut,
  isTextEditingTarget,
} from "./history-shortcuts";
import type { NavigationTool, ViewportStatus } from "./graphics/scene";
import type { ModeManager, ModeManagerState } from "./graphics/modeManager";
import { BottomBar } from "./ui/BottomBar";
import { SidePanels } from "./ui/SidePanels";
import { TopBar } from "./ui/TopBar";
import { Viewpoints } from "./Viewpoints";
import { Viewport, type ViewpointCamera } from "./viewport/Viewport";

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
  const [viewCamera, setViewCamera] = useState<ViewpointCamera | null>(null);
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
  const [navigationTool, setNavigationTool] = useState<NavigationTool>("select");

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

  const deleteSelection = useCallback(() => {
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
  }, [store, selection, visitor, setNotice]);

  useEffect(() => {
    function onHistoryKeyDown(event: KeyboardEvent) {
      // Foreground file operations own the keyboard; background backups must not block edits.
      if (visitor || (storageOperation !== null && storageOperation !== "backup")) return;
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
      handleDeleteShortcut(event, deleteSelection, editingText);
    }
    window.addEventListener("keydown", onHistoryKeyDown);
    return () => window.removeEventListener("keydown", onHistoryKeyDown);
  }, [store, selection, storageOperation, visitor, setNotice, deleteSelection]);

  useEffect(() => {
    // Filename identifies the browser tab; save status stays in the editor
    document.title = `${session.fileName || "Untitled"} - Spatia`;
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
        setNotice("Updated object. Undo is available.");
      }
    },
    [store, setNotice],
  );

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

  return (
    <div className={`editor-shell${visitor ? " is-previewing" : ""}`}>
      <a className="skip-link" href="#viewport">
        Skip to scene
      </a>
      <TopBar
        session={session}
        hasProject={project !== null}
        hasChanges={hasChanges}
        ready={status === "ready"}
        visitor={visitor}
        switching={switching}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={store.undo}
        onRedo={store.redo}
        canPreview={manager !== null && !session.busy}
        onPreview={() => {
          manager?.setMode("visitor");
          document.getElementById("viewport")?.focus();
        }}
        onExitPreview={() => manager?.setMode("editor")}
      />
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
        <SidePanels
          savedViews={
            projectScene ? (
              <Viewpoints
                key={projectScene.id}
                views={projectScene.viewpoints ?? []}
                camera={viewCamera}
                disabled={visitor || switching || status !== "ready"}
                store={store}
              />
            ) : (
              <p>Choose an environment to start saving views.</p>
            )
          }
          visitor={visitor}
          room={
            projectScene === undefined
              ? undefined
              : {
                  id: projectScene.id,
                  name: roomAsset?.name ?? projectScene.name,
                  thumbnail: thumbnailFor(projectScene.environmentAssetId),
                }
          }
          objects={objects}
          selectedId={roomSelected ? projectScene.id : selection}
          selectedObject={selectedObject}
          thumbnailFor={thumbnailFor}
          onSelect={setSelectedId}
          onTransform={onTransform}
        />

        <Viewport
          onCamera={setViewCamera}
          assets={assets}
          objects={objects}
          projectScene={project?.scenes[0] ?? null}
          selectedId={roomSelected ? projectScene.id : selection}
          dragging={dragging}
          editingEnabled={!switching}
          navigationTool={navigationTool}
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
        >
          {!visitor && (
            <BottomBar
              assets={assets}
              ready={status === "ready"}
              thumbnailFor={thumbnailFor}
              onAdd={(assetId) => place(assetId, [0, 0, 0])}
              onDragChange={setDragging}
              tool={navigationTool}
              onToolChange={setNavigationTool}
            />
          )}
        </Viewport>
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
