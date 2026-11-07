import { roomFitsGrid } from "../shared/project/room-placement";
import { environmentObject } from "../shared/project/selection-transform";
import { AudioLibrary, type AudioLibraryMode } from "./ui/AudioLibrary";
import { ExhibitPopups } from "./ui/ExhibitPopups";
import type { ContentObject } from "../shared/project/project-content";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { assets as developmentAssets } from "virtual:asset-catalogue";
import {
  isStarterRoomEnvironment,
  isRoomModel,
  roomCompanion,
  type CatalogueAsset,
} from "../shared/asset-runtime/catalogue";
import { HOTSPOT_ASSET, HOTSPOT_ASSET_ID } from "../shared/asset-runtime/hotspot";
import type { SceneObject, Vector3Tuple } from "../shared/project/scene-object";
import type { HotspotDropTarget, ProjectHotspot, Transform } from "../shared/project/project-types";
import { missingProjectCapabilities } from "../shared/project/project-capabilities";
import { playUiSound, setUiSoundVolume } from "./audio/ui-sounds";
import { createDocumentStore } from "./document-store";
import {
  handleDeleteShortcut,
  handleHistoryShortcut,
  handleObjectShortcut,
  isTextEditingTarget,
} from "./history-shortcuts";
import type { NavigationTool, ViewportStatus } from "./graphics/scene";
import type { CameraView, ModeManager, ModeManagerState } from "./graphics/modeManager";
import { createActionRunner } from "./interaction/actionHandler";
import { createPreviewNavigation } from "./interaction/preview-navigation";
import { createInteractionHandler, type Interaction } from "./interaction/interactionHandler";
import { DisplayEditor } from "./ui/DisplayEditor";
import { Button } from "../shared/ui/Button";
import { BottomBar } from "./ui/BottomBar";
import { ContentEditor, type ContentKind, type ExhibitFields } from "./ui/ContentEditor";
import { PreviewTargets } from "./ui/PreviewTargets";
import { SettingsPanel } from "./ui/SettingsPanel";
import { SidePanels } from "./ui/SidePanels";
import { TopBar } from "./ui/TopBar";
import { applyTheme, loadSettings, saveSettings, type UserSettings } from "./ui/user-settings";
import { OlderSceneImport } from "./OlderSceneImport";
import { Scenes } from "./Scenes";
import { Viewpoints } from "./Viewpoints";
import { Viewport, type ViewpointCamera } from "./viewport/Viewport";
import { MobileControls } from "./viewport/MobileControls";
import { isMobileTouchDevice } from "./viewport/mobile-device";
import type { FpsMobileControls } from "./graphics/scene";

import { ProjectConfirmation } from "./ProjectConfirmation";
import { useProjectSession } from "./persistence/use-project-session";

const EMPTY_INTERACTIONS: readonly Interaction[] = Object.freeze([]);
const EMPTY_HOTSPOTS: readonly ProjectHotspot[] = Object.freeze([]);

export type ServerEditorSession = {
  assets: readonly CatalogueAsset[];
  selectionAssets: readonly CatalogueAsset[];
  store: ReturnType<typeof createDocumentStore>;
  title: string;
  dirty: boolean;
  failed: boolean;
  saving: boolean;
  departing: boolean;
  save: (exportFile?: boolean) => Promise<boolean>;
  leave: () => void;
  publish: () => void;
};

function countSceneRules(
  snapshot: ReturnType<ReturnType<typeof createDocumentStore>["getSnapshot"]>,
): number {
  const scene = snapshot.project?.scenes.find((entry) => entry.id === snapshot.activeSceneId);
  const canonical =
    snapshot.project?.schemaVersion === 2
      ? (snapshot.project.scenes.find((entry) => entry.id === snapshot.activeSceneId)?.rules
          .length ?? 0)
      : 0;
  return (scene?.interactions.length ?? 0) + canonical;
}

function removalNotice(label: string, removedRules: number): string {
  return removedRules > 0
    ? `${label} and ${removedRules} related ${removedRules === 1 ? "rule" : "rules"}. Undo restores everything.`
    : `${label}. Undo restores it.`;
}

export function App({ server }: { server?: ServerEditorSession }) {
  const assets = server?.assets ?? developmentAssets;
  const selectionAssets = server?.selectionAssets ?? assets;
  const editorAssets = useMemo(() => [...assets, HOTSPOT_ASSET], [assets]);
  const assetKinds = useMemo(
    () => new Map(editorAssets.map((asset) => [asset.id, asset.kind])),
    [editorAssets],
  );
  const [store] = useState(() => server?.store ?? createDocumentStore(editorAssets));
  const { objects, project, activeSceneId, loadGeneration, canUndo, canRedo } =
    useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [displayEditing, setDisplayEditing] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Selection belongs to one loaded scene generation and never enters the saved project
  const [multiSelection, setMultiSelection] = useState<{
    sceneId: string | null;
    generation: number;
    ids: readonly string[];
  } | null>(null);
  const selectedIds = useMemo(
    () =>
      multiSelection?.sceneId === activeSceneId &&
      multiSelection.generation === loadGeneration &&
      selectedId !== null &&
      multiSelection.ids.includes(selectedId)
        ? multiSelection.ids
        : selectedId === null
          ? []
          : [selectedId],
    [multiSelection, activeSceneId, loadGeneration, selectedId],
  );
  const selectionRef = useRef(selectedIds);
  useEffect(() => {
    selectionRef.current = selectedIds;
  }, [selectedIds]);
  const [contentEdit, setContentEdit] = useState<{
    objectId: string;
    kind: ContentKind;
  } | null>(null);
  const [pendingTextDraft, setPendingText] = useState<{
    objectId: string;
    before: SceneObject;
    fields: ExhibitFields;
    sceneId: string | null;
    generation: number;
  } | null>(null);
  const pendingText =
    pendingTextDraft?.sceneId === activeSceneId && pendingTextDraft.generation === loadGeneration
      ? pendingTextDraft
      : null;
  const textPlacement = useMemo(() => {
    const component = pendingText?.fields.components.find((entry) => entry.type === "text");
    return pendingText && component?.type === "text"
      ? { objectId: pendingText.objectId, component }
      : undefined;
  }, [pendingText]);
  const [generatedThumbnails, setGeneratedThumbnails] = useState<Record<string, string>>({});
  const onThumbnail = useCallback((id: string, url: string) => {
    setGeneratedThumbnails((previous) => ({ ...previous, [id]: url }));
  }, []);
  const thumbnailFor = (id: string) =>
    editorAssets.find((asset) => asset.id === id)?.thumbnail ?? generatedThumbnails[id];
  const [status, setStatus] = useState<ViewportStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [audioLibrary, setAudioLibrary] = useState<AudioLibraryMode | null>(null);
  const [placingAssetId, setPlacingAssetId] = useState<string | null>(null);
  const [showExhibitTools, setShowExhibitTools] = useState(false);

  useEffect(() => {
    function cancel(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPlacingAssetId(null);
        setPendingText(null);
      }
    }
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const [feedback, setFeedback] = useState({ text: "", sequence: 0 });
  const notice = feedback.text;
  const [error, setError] = useState("");
  const setNotice = useCallback((text: string) => {
    // Every new message gets its own fade, even when the text repeats
    setFeedback((previous) => ({ text, sequence: previous.sequence + 1 }));
  }, []);
  const reportRuleRemoval = (before: ReturnType<typeof store.getSnapshot>, label: string) => {
    const removed = countSceneRules(before) - countSceneRules(store.getSnapshot());
    if (removed > 0)
      setNotice(
        `${label}. Removed ${removed} related ${removed === 1 ? "rule" : "rules"}. Undo restores everything.`,
      );
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      setFeedback((previous) => (previous.text ? { ...previous, text: "" } : previous));
    }, 3500);
    return () => clearTimeout(timer);
  }, [feedback.sequence]);
  const [viewCamera, setViewCamera] = useState<ViewpointCamera | null>(null);
  const viewCameraRef = useRef<ViewpointCamera | null>(null);
  const receiveCamera = useCallback((camera: ViewpointCamera | null) => {
    viewCameraRef.current = camera;
    setViewCamera(camera);
  }, []);
  useEffect(() => {
    if (pendingText) viewCamera?.locate(pendingText.objectId);
  }, [pendingText, viewCamera]);
  const [manager, setManager] = useState<ModeManager | null>(null);
  const [mobileControls, setMobileControls] = useState<FpsMobileControls | null>(null);
  const [modeState, setModeState] = useState<ModeManagerState | null>(null);
  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Saved settings apply straight away and are remembered in this browser
  useEffect(() => {
    saveSettings(settings);
    setUiSoundVolume(settings.volume);
    applyTheme(settings.theme);
  }, [settings]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const selection = objects.some((object) => object.id === selectedId) ? selectedId : null;
  const projectScene = useMemo(
    () => project?.scenes.find((scene) => scene.id === activeSceneId),
    [project, activeSceneId],
  );
  const groups =
    project?.schemaVersion === 2
      ? (project.scenes.find((scene) => scene.id === activeSceneId)?.groups ?? [])
      : [];

  // Room selection uses the scene ID because its asset lives in the environment field
  // Object commands still receive only placed-object IDs
  const roomSelected =
    projectScene !== undefined &&
    projectScene.environmentVisible !== false &&
    selectedId === projectScene.id;
  const [hasDeleted, setHasDeleted] = useState(false);
  const selectedObject = roomSelected
    ? environmentObject(projectScene)
    : objects.find((object) => object.id === selection);
  const hasChanges = project !== null || objects.length > 0 || hasDeleted;
  const visitor = modeState?.mode === "visitor";
  const mobileDevice = isMobileTouchDevice();
  const [navigationTool, setNavigationTool] = useState<NavigationTool>("select");
  // Start inside the scene, the overview button switch to the orbit camera
  const [view, setView] = useState<CameraView>("first");
  const walking = visitor || view === "first";
  const captured = modeState?.captured ?? false;
  const canCapture = modeState?.canCapture ?? true;
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
        // Resolve linked tracks from the active draft so playback uses current catalogue metadata
        createActionRunner(navigation, (id) => {
          const current = store.getSnapshot();
          const scene =
            current.project?.schemaVersion === 2
              ? current.project.scenes.find((entry) => entry.id === current.activeSceneId)
              : undefined;
          const audio = [
            ...(scene?.audio ?? []),
            ...(scene?.objects.flatMap((object) => object.components) ?? []),
          ].find((entry) => entry.type === "audio" && entry.id.toLowerCase() === id.toLowerCase());
          if (audio?.type !== "audio" || audio.mode !== "global") return undefined;
          const asset = assets.find(
            (entry) => entry.id === audio.assetId && entry.kind === "audio",
          );
          return asset ? { url: asset.url, loop: audio.loop, volume: audio.volume } : undefined;
        }),
        navigation.beginEvent,
      ),
    [projectScene, navigation, store, assets],
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
    setPlacingAssetId(null);
    setShowExhibitTools(false);
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
    if (visitor) return;
    const current = store.getSnapshot();
    const scene =
      current.project?.schemaVersion === 2
        ? current.project.scenes.find((entry) => entry.id === current.activeSceneId)
        : undefined;
    const audio = [
      ...(scene?.audio ?? []),
      ...(scene?.objects.flatMap((object) => object.components) ?? []),
    ].find((entry) => entry.type === "audio" && entry.id === selectedId);
    // Audio uses ordinary selection and Delete, without opening its library or deleting its owner
    if (audio) {
      const result = store.removeAudio(audio.id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSelectedId(null);
      setError("");
      setNotice(
        removalNotice(
          "Removed audio",
          countSceneRules(current) - countSceneRules(store.getSnapshot()),
        ),
      );
      playUiSound("delete");
      return;
    }
    const target =
      selection ??
      (selectedId === current.activeSceneId ||
      scene?.groups.some((group) => group.id === selectedId)
        ? selectedId
        : null);
    if (target === null) return;
    const result = store.deleteObject(target);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const removedRules = countSceneRules(current) - countSceneRules(store.getSnapshot());
    setError("");
    setHasDeleted(true);
    setSelectedId(null);
    setNotice(removalNotice(`Deleted ${result.value.name}`, removedRules));
    playUiSound("delete");
  }, [store, selection, selectedId, visitor, setNotice]);

  useEffect(() => {
    function onHistoryKeyDown(event: KeyboardEvent) {
      // Foreground file operations own the keyboard; background backups must not block edits.
      if (
        placingAssetId ||
        audioLibrary ||
        pendingText ||
        visitor ||
        (storageOperation !== null && storageOperation !== "backup")
      ) {
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
  }, [
    store,
    selection,
    storageOperation,
    visitor,
    setNotice,
    deleteSelection,
    placingAssetId,
    audioLibrary,
    pendingText,
  ]);

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
      const resolved = viewCameraRef.current?.resolveTransform?.(id, transform);
      if (!resolved) {
        setError("Keep the object inside its room and make sure it fits the display");
        return;
      }
      transform = resolved;
      const snapshot = store.getSnapshot();
      const ids = selectionRef.current;
      const object = snapshot.objects.find((entry) => entry.id === id);
      const parentId =
        object && viewCameraRef.current?.placementParent?.(object.assetId, transform, id);
      const result =
        ids.length > 1 ||
        id === snapshot.activeSceneId ||
        snapshot.objects.some((object) => object.id === id && isRoomModel(assets, object.assetId))
          ? store.setSelectionTransform(ids, id, transform)
          : parentId !== undefined &&
              parentId !== ((object as ContentObject | undefined)?.parentId ?? null)
            ? store.setPlacedTransform(id, transform, parentId)
            : store.setTransform(id, transform);
      if (!result.ok) {
        setError(result.error);
      } else if (result.changed) {
        setError("");
        setNotice("Updated object. Undo is available.");
      }
    },
    [assets, store, setNotice],
  );

  function place(
    assetId: string,
    position: Vector3Tuple,
    hotspotTarget?: HotspotDropTarget,
    roomId: string | null = null,
  ) {
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
      if (isStarterRoomEnvironment(assets, assetId) && !projectScene && !roomFitsGrid(position)) {
        setError("Keep the whole room inside the grid");
        return;
      }
      const creatingDuringInitialRecovery =
        session.busy && session.operation === "recover" && project === null;
      if (session.busy && session.operation !== "backup" && !creatingDuringInitialRecovery) {
        setNotice("Wait for the project to finish opening, then choose a room");
        return;
      }

      // The same room tile creates the environment first and independent room instances afterward
      // Keep the model reference used by saved room instances behind this one catalogue choice
      if (projectScene?.environmentAssetId) {
        const companion = roomCompanion(
          selectionAssets,
          assets.find((asset) => asset.id === assetId),
        );
        if (!companion) {
          setError("An approved room model is required to add an adjoining room.");
          setDragging(null);
          return;
        }
        const added = store.addObject(companion.id, position);
        if (added.ok) {
          setError("");
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

    const resolved = viewCamera?.resolvePlacement?.(assetId, position);
    if (!resolved) {
      setError("Keep the whole object inside a room and make sure it fits the display");
      return;
    }
    const parentId = viewCamera?.placementParent?.(assetId, resolved) ?? roomId;
    const result = store.addObject(assetId, resolved.position, parentId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    setNotice(`Added ${result.object.name}`);
    playUiSound("assetPlace");
  }

  function openContent(kind: ContentKind) {
    const object = store.getSnapshot().objects.find((entry) => entry.id === selectedId);
    if (!object) {
      setNotice("Select an exhibit in the scene or scene tree first");
      return;
    }
    if (!assets.find((asset) => asset.id === object.assetId)?.displayRole) {
      setNotice("Text can only be added to displays");
      return;
    }
    if (
      kind === "text" &&
      (object as Partial<ContentObject>).components?.some(
        (component) => component.type === "image" || component.type === "video",
      )
    ) {
      setNotice("Remove the image or video before adding text");
      return;
    }
    // Capture the selected stable ID so switching controls cannot silently retarget a pending form
    setContentEdit({ objectId: object.id, kind });
  }
  const contentObject = objects.find(
    (object) =>
      object.id === contentEdit?.objectId &&
      !!assets.find((asset) => asset.id === object.assetId)?.displayRole,
  );
  const onSceneSelect = useCallback(
    (id: string | null) => {
      // Ordinary picks replace the previous range; tree multi-selection supplies its new range afterward
      setMultiSelection(null);
      setPendingText(null);
      setSelectedId(id);
      setShowExhibitTools(
        id !== null && store.getSnapshot().objects.some((object) => object.id === id),
      );
    },
    [store],
  );
  const popupAnchor = useCallback(
    () => (selection === null ? null : (viewCamera?.bounds(selection) ?? null)),
    [viewCamera, selection],
  );

  return (
    <div
      className={`editor-shell${visitor ? " is-previewing" : ""}${walking ? " is-walking" : ""}`}
    >
      <a className="skip-link" href="#viewport">
        Skip to scene
      </a>
      <TopBar
        session={session}
        serverMode={!!server}
        serverSaving={server?.saving ?? false}
        onLeave={server?.leave}
        onPublish={server?.publish}
        hasProject={project !== null}
        hasChanges={hasChanges}
        ready={status === "ready"}
        visitor={visitor}
        switching={switching}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={store.undo}
        onRedo={store.redo}
        canPreview={
          !pendingText && manager !== null && (!session.busy || storageOperation === "backup")
        }
        onPreview={() => {
          const current = store.getSnapshot().project;
          const unavailable =
            current === null
              ? []
              : missingProjectCapabilities(
                  current,
                  new Set([
                    "appearance",
                    "multipleScenes",
                    "content:text",
                    "content:image",
                    "content:video",
                    "content:audio",
                    "audio:global",
                    "interaction:play-audio",
                    "text:placement",
                    "environment:transform",
                    "environment:visibility",
                    "text:style",
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
              scene.objects.some((object) => {
                const display = assets.find((asset) => asset.id === object.assetId);
                const content = object.components.filter((component) =>
                  ["text", "image", "video"].includes(component.type),
                );
                return (
                  content.length > 0 &&
                  !display?.displaySurface &&
                  !(
                    display?.displayRole === "physical" &&
                    content.every((component) => component.type === "text")
                  )
                );
              }),
            );
          if (unavailable.length > 0 || unsupportedDisplay) {
            // Keep capability paths tied to the saved data so authors can find the blocked feature
            const reasons = unavailable.map((issue) => `${issue.capability} at ${issue.path}`);
            if (unsupportedDisplay) {
              reasons.push("Place text, images and videos on a supported display");
            }
            setNotice(
              `This preview does not support all the scenes and interactions in this project: ${reasons.join("; ")}`,
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
        view={view}
        onToggleView={() => setView((previous) => (previous === "first" ? "third" : "first"))}
        settingsPanel={
          settingsOpen ? (
            <SettingsPanel
              settings={settings}
              onSave={(next) => {
                setSettings(next);
                setSettingsOpen(false);
              }}
              onClose={closeSettings}
            />
          ) : null
        }
        onSettings={() => setSettingsOpen((open) => !open)}
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
          assets={assets}
          sceneAudio={
            project?.schemaVersion === 2
              ? (project.scenes.find((scene) => scene.id === activeSceneId)?.audio ?? [])
              : []
          }
          onHotspotRemove={(id) => {
            const before = store.getSnapshot();
            const result = store.deleteHotspot(id);
            if (!result.ok) setNotice(result.error.message);
            else
              setNotice(
                removalNotice(
                  "Removed hotspot",
                  countSceneRules(before) - countSceneRules(store.getSnapshot()),
                ),
              );
          }}
          scenes={
            <Scenes
              key={`${loadGeneration}:${project?.projectId ?? "new"}:${activeSceneId}:${projectScene?.name}`}
              scenes={project?.scenes ?? []}
              activeSceneId={activeSceneId}
              assets={selectionAssets}
              existingAssets={assets}
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
            !projectScene?.environmentAssetId || projectScene.environmentVisible === false
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
          selectedId={selectedId}
          selectedIds={selectedIds}
          onMultiSelect={(ids, id) => {
            onSceneSelect(id);
            setMultiSelection({ sceneId: activeSceneId, generation: loadGeneration, ids });
          }}
          selectedObject={selectedObject}
          mobileDevice={mobileDevice}
          hotspots={hotspots}
          interactions={interactions}
          projectScenes={project?.scenes ?? []}
          activeSceneId={activeSceneId}
          thumbnailFor={thumbnailFor}
          onSelect={onSceneSelect}
          onDelete={deleteSelection}
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
          selectedIds={selectedIds}
          onCamera={receiveCamera}
          loadGeneration={loadGeneration}
          assets={editorAssets}
          selectableAssets={selectionAssets}
          objects={objects}
          projectScene={projectScene ?? null}
          selectedId={roomSelected ? projectScene.id : selection}
          dragging={dragging}
          textPlacement={textPlacement}
          onTextPlace={(placement) => {
            if (!pendingText) return;
            const before = store.getSnapshot();
            const result = store.editExhibit(pendingText.objectId, pendingText.before, {
              ...pendingText.fields,
              components: pendingText.fields.components.map((component) =>
                component.type === "text" ? { ...component, placement } : component,
              ),
            });
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            reportRuleRemoval(before, "Updated content");
            setPendingText(null);
            setShowExhibitTools(true);
          }}
          placingAssetId={placingAssetId}
          onPlacementCancel={() => setPlacingAssetId(null)}
          editingEnabled={!switching}
          navigationTool={pendingText ? "orbit" : navigationTool}
          view={view}
          status={status}
          attempt={attempt}
          onStatus={setStatus}
          onThumbnail={onThumbnail}
          onSelect={onSceneSelect}
          onTransform={onTransform}
          onObjectClick={onObjectClick}
          onSceneUpdate={onSceneUpdate}
          onPlace={(...args) => {
            place(...args);
            setPlacingAssetId(null);
          }}
          onDragFinish={() => {
            setDragging(null);
          }}
          onRetry={() => {
            setStatus("loading");
            setAttempt((previous) => previous + 1);
          }}
          onManager={onManager}
          onMobileControls={setMobileControls}
        >
          {!visitor &&
            !placingAssetId &&
            !pendingText &&
            !contentEdit &&
            showExhibitTools &&
            selectedObject && (
              <ExhibitPopups
                key={selectedObject.id}
                object={selectedObject}
                anchor={popupAnchor}
                displayRole={
                  editorAssets.find((asset) => asset.id === selectedObject.assetId)?.displayRole
                }
                onEdit={openContent}
                onLibrary={() => setDisplayEditing(selectedObject.id)}
                onRemoveText={() => {
                  const before = store.getSnapshot();
                  const result = store.editExhibit(selectedObject.id, selectedObject, {
                    name: selectedObject.name,
                    transform: selectedObject.transform,
                    components: (
                      (selectedObject as Partial<ContentObject>).components ?? []
                    ).filter((component) => component.type !== "text"),
                  });
                  if (!result.ok) setError(result.error.message);
                  else
                    setNotice(
                      removalNotice(
                        "Removed text",
                        countSceneRules(before) - countSceneRules(store.getSnapshot()),
                      ),
                    );
                }}
                onRemoveMedia={() => {
                  const before = store.getSnapshot();
                  const result = store.removeDisplayMedia(selectedObject.id);
                  if (!result.ok) setError(result.error.message);
                  else
                    setNotice(
                      removalNotice(
                        "Removed media",
                        countSceneRules(before) - countSceneRules(store.getSnapshot()),
                      ),
                    );
                }}
                onRemoveContent={
                  assets.find((asset) => asset.id === selectedObject.assetId)?.displayRole ===
                    "physical" &&
                  objects.some(
                    (object) => (object as Partial<ContentObject>).parentId === selectedObject.id,
                  )
                    ? () => {
                        const before = store.getSnapshot();
                        const result = store.removeDisplayedAsset(selectedObject.id);
                        if (!result.ok) setError(result.error.message);
                        else
                          setNotice(
                            removalNotice(
                              "Removed displayed object",
                              countSceneRules(before) - countSceneRules(store.getSnapshot()),
                            ),
                          );
                      }
                    : undefined
                }
                onConfirm={(appearance) => store.setAppearance(selectedObject.id, appearance)}
              />
            )}
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
              assets={selectionAssets.filter((a) => a.kind === "model" || a.kind === "environment")}
              hotspot={HOTSPOT_ASSET}
              ready={status === "ready"}
              thumbnailFor={thumbnailFor}
              onAudio={(mode) => {
                setPlacingAssetId(null);
                setAudioLibrary(mode);
              }}
              onAdd={async (assetId) => {
                const before = store.getSnapshot();
                const adjoiningRoom =
                  projectScene?.environmentAssetId && assetKinds.get(assetId) === "environment";
                const modelId = adjoiningRoom
                  ? roomCompanion(
                      selectionAssets,
                      assets.find((asset) => asset.id === assetId),
                    )?.id
                  : assetId;
                if (!modelId) {
                  setError("An approved room model is required to add an adjoining room.");
                  return;
                }
                if (!(await viewCamera?.prepareAsset(modelId)) || store.getSnapshot() !== before)
                  return;
                setShowExhibitTools(false);
                // Supplied rooms are complete environment layouts, selected at the scene origin.
                if (
                  assetKinds.get(assetId) === "environment" &&
                  !isStarterRoomEnvironment(assets, assetId) &&
                  !projectScene?.environmentAssetId
                ) {
                  setPlacingAssetId(null);
                  place(assetId, [0, 0, 0]);
                  return;
                }
                if (assetId === HOTSPOT_ASSET_ID) {
                  place(assetId, [0, 0, 0]);
                  return;
                }
                if (project === null && assetKinds.get(assetId) !== "environment") {
                  setError("Choose a room first");
                  return;
                }
                setPlacingAssetId(assetId);
                setNavigationTool("select");
              }}
              onDragChange={(assetId) => {
                if (
                  assetId &&
                  projectScene?.environmentAssetId &&
                  assetKinds.get(assetId) === "environment" &&
                  !roomCompanion(
                    selectionAssets,
                    assets.find((asset) => asset.id === assetId),
                  )
                ) {
                  setError("An approved room model is required to add an adjoining room.");
                  setDragging(null);
                  return;
                }
                setDragging(assetId);
                if (assetId !== null) {
                  setPlacingAssetId(null);
                  setShowExhibitTools(false);
                }
              }}
              tool={navigationTool}
              onToolChange={(tool) => {
                setView("third");
                setNavigationTool(tool);
              }}
              showCameraTools={true}
            />
          )}
          {mobileDevice && walking && mobileControls !== null && (
            <MobileControls controls={mobileControls} />
          )}
          {walking && status === "ready" && (
            <>
              {captured && <span className="crosshair" aria-hidden="true" />}
              <p className="walk-hint">
                {visitor
                  ? captured
                    ? "Preview mode · Left click to interact · Hold Alt for the mouse · Esc to stop"
                    : `Preview mode · ${canCapture ? "Click the scene" : "Drag"} to look around · WASD to walk · Space to jump`
                  : captured
                    ? "Click selects what's under the + · Hold the click to carry it, scroll to push or pull · Hold right click to turn it · Hold Alt for the mouse · Esc to stop"
                    : `${canCapture ? "Click the scene" : "Drag"} to look around · WASD to walk · Space to jump, double tap to fly · C to go down`}
              </p>
            </>
          )}
        </Viewport>
      </main>
      {contentEdit && contentObject && (
        <ContentEditor
          key={contentEdit.objectId}
          object={contentObject}
          initialKind={contentEdit.kind}
          media={selectionAssets
            .filter((asset) => asset.kind === "image" || asset.kind === "video")
            .map((asset) => ({ ...asset, kind: asset.kind as "image" | "video" }))}
          displayMedia={
            editorAssets.find((asset) => asset.id === contentObject.assetId)?.displayRole ===
            "digital"
          }
          onSave={(before, fields) => {
            if (
              assets.find((asset) => asset.id === contentObject.assetId)?.displayRole ===
                "physical" &&
              !(before as Partial<ContentObject>).components?.some(
                (component) => component.type === "text",
              ) &&
              fields.components.some(
                (component) =>
                  component.type === "text" && component.runs.some((run) => run.text.trim()),
              )
            ) {
              setPendingText({
                objectId: contentEdit.objectId,
                before,
                fields,
                sceneId: activeSceneId,
                generation: loadGeneration,
              });
              setPlacingAssetId(null);
              setDragging(null);
              setView("third");
              return { ok: true, value: true };
            }
            const previous = store.getSnapshot();
            const result = store.editExhibit(contentEdit.objectId, before, fields);
            if (result.ok) reportRuleRemoval(previous, "Updated content");
            return result;
          }}
          onClose={() => setContentEdit(null)}
        />
      )}
      {audioLibrary && (
        <AudioLibrary
          assets={selectionAssets}
          mode={audioLibrary}
          targetName={selectedObject?.name ?? null}
          onAdd={(id) =>
            store.addAudio(
              id,
              audioLibrary === "background" ? "global" : "spatial",
              selectedObject?.id ?? null,
            )
          }
          onClose={() => setAudioLibrary(null)}
        />
      )}
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
              placementFor={(ownerId, assetId) => viewCamera?.displayPlacement?.(ownerId, assetId)}
              initialKind="image"
              asset={asset}
              assets={selectionAssets}
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
