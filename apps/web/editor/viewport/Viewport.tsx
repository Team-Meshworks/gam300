import type { ContentComponent } from "../../shared/project/project-content";
import { useEffect, useRef, type DragEvent, type ReactNode } from "react";
import {
  assetDragType,
  isRoomModel,
  type CatalogueAsset,
} from "../../shared/asset-runtime/catalogue";
import { HOTSPOT_ASSET_ID } from "../../shared/asset-runtime/hotspot";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type {
  CameraPose,
  HotspotDropTarget,
  ProjectScene,
  Transform,
} from "../../shared/project/project-types";
import type { initScene, NavigationTool, ViewportStatus } from "../graphics/scene";
import type { FpsMobileControls } from "../graphics/scene";
import type { CameraView, ModeManager } from "../graphics/modeManager";

const statusMessages = {
  loading: "Loading assets…",
  ready: "Scene ready",
  error: "Couldn't load the 3D view. Check your connection and retry.",
  "download-error": "Couldn't start the 3D view. Reload the editor to try again.",
  unsupported: "The 3D view needs WebGL 2. Check your browser's graphics settings and retry.",
  "authentication-required":
    "Sign in to load rooms and objects, then retry. Your scene is still here.",
};

export type ViewpointCamera = {
  prepareAsset: (id: string) => Promise<boolean>;
  preloadAsset?: (id: string | null) => void;
  isRoomPlacementValid?: (id: string, position: Vector3Tuple) => boolean;
  displayPlacement?: (ownerId: string, assetId: string) => Promise<Transform | undefined>;
  resolveTransform?: (id: string, transform: Transform) => Transform | undefined;
  resolvePlacement?: (assetId: string, position: Vector3Tuple) => Transform | undefined;
  placementParent?: (assetId: string, transform: Transform, objectId?: string) => string | null;
  capture: () => CameraPose;
  show: (pose: CameraPose) => void;
  visitorTouches?: (id: string) => boolean;
  locate: (id: string) => void;
  toggleDisplayMedia: (id: string) => void;
  playSpatialAudio?: (id: string) => void;
  hotspotAnchor: (id: string) => Vector3Tuple | undefined;
  bounds: (id: string) => { left: number; right: number; top: number; bottom: number } | null;
};

type ViewportProps = {
  onCamera: (camera: ViewpointCamera | null) => void;
  assets: readonly CatalogueAsset[];
  selectableAssets?: readonly CatalogueAsset[];
  objects: readonly SceneObject[];
  projectScene: ProjectScene | null;
  loadGeneration: number;
  selectedId: string | null;
  selectedIds?: readonly string[];
  dragging: string | null;
  placingAssetId?: string | null;
  textPlacement?:
    | { objectId: string; component: Extract<ContentComponent, { type: "text" }> }
    | undefined;
  onTextPlace?: (placement: Transform) => void;
  editingEnabled: boolean;
  allowInspection?: boolean;
  navigationTool: NavigationTool;
  view: CameraView;
  status: ViewportStatus;
  attempt: number;
  onStatus: (status: ViewportStatus) => void;
  onAudioError?: (message: string) => void;
  onThumbnail: (id: string, url: string) => void;
  requestThumbnail: (id: string) => void;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, transform: Transform) => void;
  onObjectClick: (id: string) => void;
  onSceneUpdate: (deltaSeconds: number) => void;
  onPlace: (
    assetId: string,
    position: Vector3Tuple,
    hotspotTarget?: HotspotDropTarget,
    roomId?: string | null,
  ) => void;
  onDragFinish: () => void;
  onPlacementCancel?: () => void;
  onRetry: () => void;
  onManager: (manager: ModeManager) => void;
  onMobileControls: (controls: FpsMobileControls | null) => void;
  children?: ReactNode;
};

export function Viewport({
  onCamera,
  assets,
  selectableAssets = assets,
  objects,
  projectScene,
  loadGeneration,
  selectedId,
  selectedIds = [],
  dragging,
  placingAssetId,
  textPlacement,
  onTextPlace,
  editingEnabled,
  allowInspection = false,
  navigationTool,
  view,
  status,
  attempt,
  onStatus,
  onAudioError,
  onThumbnail,
  requestThumbnail,
  onSelect,
  onTransform,
  onObjectClick,
  onSceneUpdate,
  onPlace,
  onDragFinish,
  onPlacementCancel,
  onRetry,
  onManager,
  onMobileControls,
  children,
}: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ReturnType<typeof initScene>>(undefined);
  const previewPoint = useRef<{
    id: string;
    position: Vector3Tuple | undefined;
    ownerId: string | undefined;
  } | null>(null);
  const snapshotRef = useRef({
    objects,
    selectedId,
    selectedIds,
    projectScene,
    loadGeneration,
    editingEnabled,
    allowInspection,
    navigationTool,
    view,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    let disposed = false;
    // Show the shell before downloading and evaluating the renderer
    import("../graphics/scene")
      .then(({ initScene }) => {
        if (disposed) return;
        const scene = initScene(host, assets, {
          onStatus,
          onThumbnail,
          requestThumbnail,
          onSelect,
          onTransform,
          onObjectClick,
          onUpdate: onSceneUpdate,
          selectableAssets,
          ...(onAudioError ? { onAudioError } : {}),
        });
        sceneRef.current = scene;
        const current = snapshotRef.current;
        // Establish the requested navigation mode before applying the authored camera.
        // Otherwise first-person initialization can replace the authored pose with the
        // orbit controller's default target before the first selection update.
        scene?.modeManager.initializeView(current.view);
        scene?.update(
          current.objects,
          current.selectedId,
          current.projectScene,
          current.loadGeneration,
          current.selectedIds,
        );
        scene?.setEditingEnabled(current.editingEnabled, current.allowInspection);
        scene?.setNavigationTool(current.navigationTool);
        if (scene !== undefined) {
          onManager(scene.modeManager);
          onMobileControls(scene.mobileControls);
          onCamera({
            prepareAsset: scene.prepareAsset,
            preloadAsset: scene.preloadAsset,
            isRoomPlacementValid: scene.isRoomPlacementValid,
            displayPlacement: scene.getDisplayPlacement,
            resolveTransform: scene.resolveTransform,
            resolvePlacement: scene.resolvePlacement,
            placementParent: scene.getPlacementParent,
            capture: scene.captureCamera,
            show: scene.showCamera,
            visitorTouches: scene.visitorTouches,
            locate: scene.locateObject,
            toggleDisplayMedia: scene.toggleDisplayMedia,
            playSpatialAudio: scene.playSpatialAudio,
            hotspotAnchor: scene.getHotspotAnchor,
            bounds: scene.getObjectScreenBounds,
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error("Failed to load the 3D view", error);
          onStatus("download-error");
        }
      });
    return () => {
      disposed = true;
      onCamera(null);
      onMobileControls(null);
      sceneRef.current?.dispose();
      sceneRef.current = undefined;
    };
  }, [
    assets,
    selectableAssets,
    attempt,
    onStatus,
    onAudioError,
    onThumbnail,
    requestThumbnail,
    onSelect,
    onTransform,
    onObjectClick,
    onSceneUpdate,
    onManager,
    onCamera,
    onMobileControls,
  ]);

  useEffect(() => {
    snapshotRef.current = {
      objects,
      selectedId,
      selectedIds,
      projectScene,
      loadGeneration,
      editingEnabled,
      allowInspection,
      navigationTool,
      view,
    };
    sceneRef.current?.update(objects, selectedId, projectScene, loadGeneration, selectedIds);
    sceneRef.current?.setEditingEnabled(editingEnabled, allowInspection);
    sceneRef.current?.setNavigationTool(navigationTool);
    sceneRef.current?.modeManager.setView(view);
  }, [
    objects,
    selectedId,
    selectedIds,
    projectScene,
    loadGeneration,
    editingEnabled,
    allowInspection,
    navigationTool,
    view,
    assets,
    attempt,
  ]);

  useEffect(() => {
    if (dragging) void sceneRef.current?.preparePlacement(dragging);
    if (!dragging && !placingAssetId) {
      sceneRef.current?.showPlacementPreview(undefined, undefined);
      if (hostRef.current) hostRef.current.style.cursor = "";
    }
  }, [dragging, placingAssetId]);

  useEffect(() => {
    const id = dragging ?? placingAssetId;
    if (!id) {
      previewPoint.current = null;
      sceneRef.current?.showPlacementPreview(undefined, undefined);
      return;
    }
    const last = previewPoint.current;
    // A completed load must reveal the ghost at the last pointer position
    if (last?.id === id) sceneRef.current?.showPlacementPreview(id, last.position, last.ownerId);
    else sceneRef.current?.showPlacementPreview(id, placingAssetId ? [0, 0, 0] : undefined);
  }, [dragging, placingAssetId, status]);

  function showPreview(id: string, position: Vector3Tuple | undefined, ownerId?: string) {
    previewPoint.current = { id, position, ownerId };
    return sceneRef.current?.showPlacementPreview(id, position, ownerId);
  }

  useEffect(
    () => () => {
      sceneRef.current?.clearTextPlacement();
      if (hostRef.current) {
        hostRef.current.style.cursor = "";
        delete hostRef.current.dataset.textPlacementValid;
      }
    },
    [textPlacement, status],
  );

  function isRoom(id: string | null | undefined) {
    return (
      isRoomModel(assets, id ?? undefined) ||
      assets.some((asset) => asset.id === id && asset.kind === "environment")
    );
  }
  function accepts(event: DragEvent) {
    return (
      dragging &&
      editingEnabled &&
      (status === "ready" || status === "loading") &&
      sceneRef.current?.modeManager.getState().mode === "editor" &&
      event.dataTransfer.types.includes(assetDragType)
    );
  }

  return (
    <section className="viewport" id="viewport" tabIndex={-1} aria-label="Scene">
      <div
        className={`viewport-stage${dragging ? " is-dragging" : ""}`}
        style={{
          pointerEvents: status === "loading" && !dragging && !placingAssetId ? "none" : undefined,
        }}
        ref={hostRef}
        data-placing-text={textPlacement?.objectId}
        data-placing-asset={placingAssetId ?? undefined}
        data-dragging-asset={dragging ?? undefined}
        onPointerMove={(event) => {
          if (textPlacement) {
            const placement = sceneRef.current?.showTextPlacement(
              textPlacement.objectId,
              textPlacement.component,
              event.clientX,
              event.clientY,
            );
            event.currentTarget.style.cursor = placement ? "crosshair" : "not-allowed";
            event.currentTarget.dataset.textPlacementValid = String(!!placement);
            return;
          }
          if (placingAssetId) {
            const scene = sceneRef.current;
            const valid = showPreview(
              placingAssetId,
              scene?.getDropSurface(event.clientX, event.clientY, isRoom(placingAssetId)),
              placingAssetId === HOTSPOT_ASSET_ID
                ? scene?.pickObjectAt(event.clientX, event.clientY)
                : undefined,
            );
            event.currentTarget.style.cursor = valid ? "crosshair" : "not-allowed";
          }
        }}
        onPointerLeave={() => {
          if (textPlacement) sceneRef.current?.clearTextPlacement();
          if (placingAssetId) showPreview(placingAssetId, undefined);
        }}
        aria-busy={status === "loading"}
        onPointerDownCapture={(event) => {
          if (textPlacement && event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
            const placement = sceneRef.current?.showTextPlacement(
              textPlacement.objectId,
              textPlacement.component,
              event.clientX,
              event.clientY,
            );
            if (placement) onTextPlace?.(placement);
            return;
          }
          // A library pick owns the next scene click; cancel remains with the caller
          if (
            !placingAssetId ||
            !editingEnabled ||
            (status !== "ready" && status !== "loading") ||
            sceneRef.current?.modeManager.getState().mode !== "editor"
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (event.button !== 0) {
            onPlacementCancel?.();
            return;
          }
          const position = sceneRef.current.getDropSurface(
            event.clientX,
            event.clientY,
            isRoom(placingAssetId),
          );
          if (position) {
            const objectId =
              placingAssetId === HOTSPOT_ASSET_ID
                ? sceneRef.current.pickObjectAt(event.clientX, event.clientY)
                : undefined;
            onPlace(
              placingAssetId,
              position,
              objectId === undefined ? undefined : { objectId },
              sceneRef.current.getRoomAtPosition(position),
            );
          }
        }}
        onDragOver={(event) => {
          if (!accepts(event)) {
            return;
          }
          event.preventDefault();
          if (dragging === HOTSPOT_ASSET_ID) {
            const scene = sceneRef.current;
            const objectId = scene?.pickObjectAt(event.clientX, event.clientY) ?? selectedId;
            const anchor = objectId === null ? undefined : scene?.getHotspotAnchor(objectId);
            event.dataTransfer.dropEffect = anchor === undefined ? "none" : "copy";
            showPreview(
              HOTSPOT_ASSET_ID,
              anchor === undefined ? undefined : [0, 0, 0],
              objectId ?? undefined,
            );
            return;
          }
          const scene = sceneRef.current;
          const position = scene?.getDropSurface(event.clientX, event.clientY, isRoom(dragging));
          const valid = dragging && showPreview(dragging, position);
          // Keep a valid surface droppable while the incoming model's bounds are loading
          const pending = dragging && position && scene && !scene.isPlacementReady(dragging);
          event.dataTransfer.dropEffect = valid || pending ? "copy" : "none";
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            if (dragging) showPreview(dragging, undefined);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const assetId = event.dataTransfer.getData(assetDragType);
          if (
            assetId === dragging &&
            accepts(event) &&
            assets.some((asset) => asset.id === assetId)
          ) {
            const scene = sceneRef.current;
            if (assetId === HOTSPOT_ASSET_ID) {
              const objectId = scene?.pickObjectAt(event.clientX, event.clientY);
              onPlace(assetId, [0, 0, 0], objectId === undefined ? undefined : { objectId });
            } else {
              const position = scene?.getDropSurface(event.clientX, event.clientY, isRoom(assetId));
              if (position !== undefined)
                onPlace(assetId, position, undefined, scene?.getRoomAtPosition(position) ?? null);
            }
          }
          sceneRef.current?.showPlacementPreview(undefined, undefined);
          onDragFinish();
        }}
      />
      {children}
      {dragging && <p className="drop-cue">Drop to place</p>}
      {textPlacement && (
        <p className="drop-cue" role="status">
          Click the case to place text · Escape to cancel
        </p>
      )}
      {placingAssetId && (
        <p className="drop-cue" role="status">
          Click to place · Escape to cancel
        </p>
      )}
      <div className={status === "ready" ? "sr-only" : "viewport-feedback"}>
        <p role="status">{statusMessages[status]}</p>
        {status === "authentication-required" && (
          <a href="/login" target="_blank" rel="noopener noreferrer">
            Sign in in another tab
          </a>
        )}
        {(status === "error" ||
          status === "unsupported" ||
          status === "authentication-required") && (
          <button className="retry-button" type="button" onClick={onRetry}>
            Retry
          </button>
        )}
        {status === "download-error" && (
          <button className="retry-button" type="button" onClick={() => window.location.reload()}>
            Reload editor
          </button>
        )}
      </div>
    </section>
  );
}
