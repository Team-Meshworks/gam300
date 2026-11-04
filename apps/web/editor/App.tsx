import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { assets } from "virtual:asset-catalogue";
import { HOTSPOT_ASSET, HOTSPOT_ASSET_ID } from "../shared/asset-runtime/hotspot";
import type { ContentObject } from "../shared/project/project-content";
import type { Vector3Tuple } from "../shared/project/scene-object";
import type { HotspotDropTarget, ProjectHotspot, Transform } from "../shared/project/project-types";
import { missingProjectCapabilities } from "../shared/project/project-capabilities";
import { playUiSound } from "./audio/ui-sounds";
import { createDocumentStore } from "./document-store";
import {
  handleDeleteShortcut,
  handleHistoryShortcut,
  handleObjectShortcut,
  isTextEditingTarget,
} from "./history-shortcuts";
import type { NavigationTool, ViewportStatus } from "./graphics/scene";
import type { ModeManager, ModeManagerState } from "./graphics/modeManager";
import { createActionRunner } from "./interaction/actionHandler";
import { createPreviewNavigation } from "./interaction/preview-navigation";
import { createInteractionHandler, type Interaction } from "./interaction/interactionHandler";
import { DisplayEditor } from "./ui/DisplayEditor";
import { Button } from "../shared/ui/Button";
import { BottomBar } from "./ui/BottomBar";
import { PreviewTargets } from "./ui/PreviewTargets";
import { SidePanels } from "./ui/SidePanels";
import { TopBar } from "./ui/TopBar";
import { OlderSceneImport } from "./OlderSceneImport";
import { Scenes } from "./Scenes";
import { Viewpoints } from "./Viewpoints";
import { Viewport, type ViewpointCamera } from "./viewport/Viewport";

import { ProjectConfirmation } from "./ProjectConfirmation";
import { useProjectSession } from "./persistence/use-project-session";

// Same catalog used by the viewport; saved references need to resolve here too
const editorAssets = [...assets, HOTSPOT_ASSET];
const assetKinds = new Map(editorAssets.map((asset) => [asset.id, asset.kind]));
const EMPTY_INTERACTIONS: readonly Interaction[] = Object.freeze([]);
const EMPTY_HOTSPOTS: readonly ProjectHotspot[] = Object.freeze([]);

export type ServerEditorSession = {
  store: ReturnType<typeof createDocumentStore>;
  title: string;
  dirty: boolean;
  failed: boolean;
  saving: boolean;
  departing: boolean;
  save: (exportFile?: boolean) => Promise<boolean>;
  leave: () => void;
};

export function App({ server }: { server?: ServerEditorSession }) {
  const [store] = useState(() => server?.store ?? createDocumentStore(editorAssets));
  const { objects, project, activeSceneId, loadGeneration, canUndo, canRedo } =
    useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [displayEditing, setDisplayEditing] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generatedThumbnails, setGeneratedThumbnails] = useState<Record<string, string>>({});
  const onThumbnail = useCallback((id: string, url: string) => {
    setGeneratedThumbnails((previous) => ({ ...previous, [id]: url }));
  }, []);
  const thumbnailFor = (id: string) =>
    editorAssets.find((asset) => asset.id === id)?.thumbnail ?? generatedThumbnails[id];
  const [status, setStatus] = useState<ViewportStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
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
  const projectScene = useMemo(
    () => project?.scenes.find((scene) => scene.id === activeSceneId),
    [project, activeSceneId],
  );
  const groups =
    project?.schemaVersion === 2
      ? (project.scenes.find((scene) => scene.id === activeSceneId)?.groups ?? [])
      : [];
  const groupSelected = groups.some((group) => group.id === selectedId);

  // Room selection uses the scene ID because its asset lives in the environment field
  // Object commands still receive only placed-object IDs
  const roomSelected = projectScene !== undefined && selectedId === projectScene.id;
  const [hasDeleted, setHasDeleted] = useState(false);
  const selectedObject = objects.find((object) => object.id === selection);
  const hasChanges = project !== null || objects.length > 0 || hasDeleted;
  const visitor = modeState?.mode === "visitor";
  const [navigationTool, setNavigationTool] = useState<NavigationTool>("select");
  const interactions = projectScene?.interactions ?? EMPTY_INTERACTIONS;
  const hotspots = projectScene?.hotspots ?? EMPTY_HOTSPOTS;

  const navigation = useMemo(
    () =>
      createPreviewNavigation({
        snapshot: store.getSnapshot,
        switchScene: store.switchScene,
        showCamera: (pose) => viewCamera?.show(pose),
        notice: setNotice,
      }),
    [store, viewCamera, setNotice],
  );
  const interactionHandler = useMemo(
    () =>
      createInteractionHandler(
        projectScene?.interactions ?? EMPTY_INTERACTIONS,
        projectScene?.hotspots ?? EMPTY_HOTSPOTS,
        createActionRunner(navigation),
        navigation.beginEvent,
      ),
    [projectScene, navigation],
  );
  const interactionHandlerRef = useRef(interactionHandler);
  useEffect(() => {
    interactionHandlerRef.current = interactionHandler;
  }, [interactionHandler]);
  // Leaving Preview, replacing the handler or unmounting ends that preview session
  useEffect(() => {
    if (!visitor) return;
    interactionHandler.sceneStarted();
    return () => interactionHandler.reset();
  }, [visitor, interactionHandler]);
  const onObjectClick = useCallback((id: string) => {
    interactionHandlerRef.current.objectClicked(id);
  }, []);
  const onSceneUpdate = useCallback((deltaSeconds: number) => {
    interactionHandlerRef.current.update(deltaSeconds);
  }, []);
  const onInteractionsChange = useCallback(
    (next: Interaction[]) => {
      const result = store.setInteractions(next);
      if (!result.ok) setNotice(result.error.message);
    },
    [store, setNotice],
  );

  const onManager = useCallback((next: ModeManager) => {
    setManager(next);
    setModeState(next.getState());
  }, []);

  useEffect(() => (manager === null ? undefined : manager.subscribe(setModeState)), [manager]);

  const onReplace = useCallback(() => {
    setSelectedId(null);
    setDragging(null);
    setError("");
    setHasDeleted(false);
  }, []);
  const localSession = useProjectSession(
    store,
    editorAssets,
    project,
    objects.length,
    onReplace,
    setNotice,
    () => playUiSound("save"),
    !server,
  );
  const session = server
    ? {
        ...localSession,
        operation: server.departing ? ("switch" as const) : null,
        fileName: server.title,
        dirty: server.dirty,
        fileFailed: server.failed,
        busy: server.departing,
        save: server.save,
      }
    : localSession;
  // Here rather than in the dialog, whose mount effect run twice in development
  useEffect(() => {
    if (session.confirmation) playUiSound("warning");
  }, [session.confirmation]);
  const storageOperation = session.operation;
  const switching =
    storageOperation === "switch" ||
    storageOperation === "recover" ||
    storageOperation === "import";

  const deleteSelection = useCallback(() => {
    if (selection === null || visitor) {
      return;
    }
    const result = store.deleteObject(selection);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError("");
    setHasDeleted(true);
    setSelectedId(null);
    setNotice(`Deleted ${result.value.name}. Undo restores it.`);
    playUiSound("delete");
  }, [store, selection, visitor, setNotice]);

  useEffect(() => {
    function onHistoryKeyDown(event: KeyboardEvent) {
      // Foreground file operations own the keyboard; background backups must not block edits.
      if (visitor || (storageOperation !== null && storageOperation !== "backup")) {
        return;
      }
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
      if (visitor || event.defaultPrevented || event.isComposing || event.altKey) {
        return;
      }
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

  function place(assetId: string, position: Vector3Tuple, hotspotTarget?: HotspotDropTarget) {
    if (visitor) {
      return;
    }
    session.clearError();
    if (assetId === HOTSPOT_ASSET_ID) {
      if (projectScene === undefined) {
        setNotice("Choose a room before adding hotspots");
        return;
      }
      const objectId = hotspotTarget?.objectId ?? selection;
      if (objectId === null) {
        setNotice("Select an object to attach the hotspot to");
        return;
      }
      const localPosition = viewCamera?.hotspotAnchor(objectId);
      if (localPosition === undefined) {
        setNotice("Bring the selected object fully into view before adding a hotspot");
        return;
      }
      const result = store.addHotspot(objectId, localPosition);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setError("");
      setNotice("Hotspot attached to the selected object");
      return;
    }

    // Choosing the first room turns the grid scene into a saveable project
    // Room placement uses the environment slot so it survives JSON reconstruction
    if (assetKinds.get(assetId) === "environment") {
      if (session.busy) {
        setNotice("Wait for the project to finish opening, then choose a room");
        return;
      }

      // The same room tile creates the environment first and independent room instances afterward
      // Keep the model reference used by saved room instances behind this one catalogue choice
      if (projectScene?.environmentAssetId === assetId) {
        const added = store.addObject("test-room-module-v1", position);
        if (added.ok) {
          setSelectedId(added.object.id);
          setNotice(`Added ${added.object.name}`);
        } else {
          setError(added.error);
        }
        setDragging(null);
        return;
      }
      if (project !== null) {
        const changed = store.setEnvironment(assetId);
        if (!changed.ok) setError(changed.error.message);
        else {
          setError("");
          setNotice("Scene environment updated. Undo is available.");
          playUiSound("assetPlace");
        }
        setDragging(null);
        return;
      }
      const created = store.createProject(assetId);
      if (!created.ok) {
        setError(created.error.message);
        return;
      }
      setError("");
      setSelectedId(created.value.scenes[0]!.id);
      setDragging(null);
      if (created.value.scenes[0]?.objects.length === 0) {
        session.markPristine(created.value);
      }
      setNotice("Project created; choose Save to name its file");
      playUiSound("assetPlace");
      return;
    }
    // Clicks and drops share this path; room selection starts the project before furnishing it
    if (store.getSnapshot().project === null) {
      setDragging(null);
      setError("Choose a room first");
      return;
    }

    const result = store.addObject(
      assetId,
      position,
      roomSelected || groupSelected ? selectedId : selection,
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    setNotice(`Added ${result.object.name}`);
    playUiSound("assetPlace");
  }

  return (
    <div className={`editor-shell${visitor ? " is-previewing" : ""}`}>
      <a className="skip-link" href="#viewport">
        Skip to scene
      </a>
      <TopBar
        session={session}
        serverMode={!!server}
        serverSaving={server?.saving ?? false}
        onLeave={server?.leave}
        hasProject={project !== null}
        hasChanges={hasChanges}
        ready={status === "ready"}
        visitor={visitor}
        switching={switching}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={store.undo}
        onRedo={store.redo}
        canPreview={manager !== null && (!session.busy || storageOperation === "backup")}
        onPreview={() => {
          const current = store.getSnapshot().project;
          const unavailable =
            current === null
              ? []
              : missingProjectCapabilities(
                  current,
                  new Set([
                    "multipleScenes",
                    "content:text",
                    "content:image",
                    "content:video",
                    "text:bold",
                    "text:italic",
                    "text:underline",
                    "interaction:navigate-scene",
                    "interaction:move-to-viewpoint",
                  ]),
                );
          const unsupportedDisplay =
            current?.schemaVersion === 2 &&
            current.scenes.some((scene) =>
              scene.objects.some(
                (object) =>
                  object.components.some((component) =>
                    ["text", "image", "video"].includes(component.type),
                  ) && !assets.find((asset) => asset.id === object.assetId)?.displaySurface,
              ),
            );
          if (unavailable.length > 0 || unsupportedDisplay) {
            setNotice(
              "This preview does not support all the scenes and interactions in this project",
            );
            return;
          }
          navigation.start();
          manager?.setMode("visitor");
          playUiSound("enterPreview");
          document.getElementById("viewport")?.focus();
        }}
        onExitPreview={() => {
          manager?.setMode("editor");
          navigation.end();
          playUiSound("goingBack");
        }}
      />
      {/* Reset the input so choosing the same file again still fires a change */}
      {!server && (
        <input
          id="project-import"
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file !== undefined) {
              void session.importFile(file);
            }
          }}
        />
      )}

      {!server && (
        <OlderSceneImport
          olderSceneFiles={session.olderSceneFiles}
          assets={assets}
          onImport={session.importConvertedFile}
          onError={setError}
        />
      )}
      <main className="workspace" inert={switching}>
        <SidePanels
          scenes={
            <Scenes
              key={`${loadGeneration}:${project?.projectId ?? "new"}:${activeSceneId}:${projectScene?.name}`}
              scenes={project?.scenes ?? []}
              activeSceneId={activeSceneId}
              assets={assets}
              store={store}
              disabled={visitor || switching || status !== "ready"}
              onSwitch={() => {
                setSelectedId(null);
                setDragging(null);
                setError("");
              }}
            />
          }
          savedViews={
            projectScene ? (
              <Viewpoints
                key={`${loadGeneration}:${projectScene.id}`}
                views={projectScene.viewpoints ?? []}
                startCamera={projectScene.startCamera}
                camera={viewCamera}
                disabled={visitor || switching || status !== "ready"}
                store={store}
              />
            ) : (
              <p>Create a scene in the Scenes panel to start saving views.</p>
            )
          }
          visitor={visitor}
          room={
            !projectScene?.environmentAssetId
              ? undefined
              : {
                  id: projectScene.id,
                  name: projectScene.name,
                  thumbnail: thumbnailFor(projectScene.environmentAssetId),
                }
          }
          groups={groups}
          hierarchy={{
            // Route room and object renames through the same validation and undo history
            rename(id, name) {
              const result = store.renameObject(id, name);
              if (!result.ok) setError(result.error.message);
              return result.ok;
            },
            // The store owns validation and undo; panels only choose the requested operation
            move(id, parentId) {
              const result = store.reparent(id, parentId);
              if (!result.ok) {
                setError(result.error.message);
                return;
              }
              setError("");
              setNotice("Hierarchy updated. Undo is available.");
            },
          }}
          objects={objects}
          selectedId={roomSelected ? projectScene.id : groupSelected ? selectedId : selection}
          selectedObject={selectedObject}
          hotspots={hotspots}
          interactions={interactions}
          projectScenes={project?.scenes ?? []}
          activeSceneId={activeSceneId}
          thumbnailFor={thumbnailFor}
          onSelect={setSelectedId}
          onTransform={onTransform}
          onInteractionsChange={onInteractionsChange}
          onLocate={(id) => {
            const object = objects.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
            if (!object) return;
            setSelectedId(object.id);
            viewCamera?.locate(object.id);
          }}
        />

        <Viewport
          onCamera={setViewCamera}
          loadGeneration={loadGeneration}
          assets={editorAssets}
          objects={objects}
          projectScene={projectScene ?? null}
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
          onObjectClick={onObjectClick}
          onSceneUpdate={onSceneUpdate}
          onPlace={place}
          onDragFinish={() => setDragging(null)}
          onRetry={() => {
            setStatus("loading");
            setAttempt((previous) => previous + 1);
          }}
          onManager={onManager}
        >
          {visitor && (
            <div className="display-media-controls">
              {objects
                .filter((object) =>
                  (object as ContentObject).components?.some(
                    (component) => component.type === "video",
                  ),
                )
                .map((object) => (
                  <Button key={object.id} onClick={() => viewCamera?.toggleDisplayMedia(object.id)}>
                    Play / pause {object.name}
                  </Button>
                ))}
            </div>
          )}
          {visitor && (
            <PreviewTargets
              objects={objects}
              hotspots={hotspots}
              interactions={interactions}
              onActivate={onObjectClick}
            />
          )}
          {!visitor && (
            <BottomBar
              assets={assets.filter((a) => a.kind === "model" || a.kind === "environment")}
              hotspot={HOTSPOT_ASSET}
              ready={status === "ready"}
              thumbnailFor={thumbnailFor}
              onAdd={(assetId) => place(assetId, [0, 0, 0])}
              onDragChange={setDragging}
              tool={navigationTool}
              onToolChange={setNavigationTool}
              selectedDisplay={
                selectedObject && assets.find((a) => a.id === selectedObject.assetId)?.displayRole
                  ? {
                      name: selectedObject.name,
                      onEdit: () => setDisplayEditing(selectedObject.id),
                      disabled: switching || status !== "ready",
                    }
                  : undefined
              }
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
      {displayEditing &&
        !visitor &&
        project &&
        (() => {
          const object = objects.find((entry) => entry.id === displayEditing);
          const asset = assets.find((entry) => entry.id === object?.assetId);
          return object && asset?.displayRole ? (
            <DisplayEditor
              key={`${loadGeneration}:${activeSceneId}:${object.id}`}
              object={object}
              asset={asset}
              assets={assets}
              project={project}
              store={store}
              thumbnailFor={thumbnailFor}
              onClose={() => setDisplayEditing(null)}
            />
          ) : null;
        })()}
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
