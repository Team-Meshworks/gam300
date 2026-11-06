import type { ContentComponent } from "../../shared/project/project-content";
import { useEffect, useRef, type DragEvent, type ReactNode } from "react";
import { assetDragType, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
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
  displayPlacement?: (ownerId: string, assetId: string) => Promise<Transform | undefined>;
  resolveTransform?: (id: string, transform: Transform) => Transform | undefined;
  resolvePlacement?: (assetId: string, position: Vector3Tuple) => Transform | undefined;
  placementParent?: (assetId: string, transform: Transform, objectId?: string) => string | null;
  capture: () => CameraPose;
  show: (pose: CameraPose) => void;
  locate: (id: string) => void;
  toggleDisplayMedia: (id: string) => void;
  hotspotAnchor: (id: string) => Vector3Tuple | undefined;
  bounds: (id: string) => { left: number; right: number; top: number; bottom: number } | null;
};

type ViewportProps = {
  onCamera: (camera: ViewpointCamera | null) => void;
  assets: readonly CatalogueAsset[];
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
  navigationTool: NavigationTool;
  view: CameraView;
  status: ViewportStatus;
  attempt: number;
  onStatus: (status: ViewportStatus) => void;
  onThumbnail: (id: string, url: string) => void;
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
  navigationTool,
  view,
  status,
  attempt,
  onStatus,
  onThumbnail,
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
  const snapshotRef = useRef({
    objects,
    selectedId,
    selectedIds,
    projectScene,
    loadGeneration,
    editingEnabled,
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
          onSelect,
          onTransform,
          onObjectClick,
          onUpdate: onSceneUpdate,
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
        scene?.setEditingEnabled(current.editingEnabled);
        scene?.setNavigationTool(current.navigationTool);
        if (scene !== undefined) {
          onManager(scene.modeManager);
          onMobileControls(scene.mobileControls);
          onCamera({
            prepareAsset: scene.prepareAsset,
            displayPlacement: scene.getDisplayPlacement,
            resolveTransform: scene.resolveTransform,
            resolvePlacement: scene.resolvePlacement,
            placementParent: scene.getPlacementParent,
            capture: scene.captureCamera,
            show: scene.showCamera,
            locate: scene.locateObject,
            toggleDisplayMedia: scene.toggleDisplayMedia,
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
    attempt,
    onStatus,
    onThumbnail,
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
      navigationTool,
      view,
    };
    sceneRef.current?.update(objects, selectedId, projectScene, loadGeneration, selectedIds);
    sceneRef.current?.setEditingEnabled(editingEnabled);
    sceneRef.current?.setNavigationTool(navigationTool);
    sceneRef.current?.modeManager.setView(view);
  }, [
    objects,
    selectedId,
    selectedIds,
    projectScene,
    loadGeneration,
    editingEnabled,
    navigationTool,
    view,
    assets,
    attempt,
  ]);

  useEffect(() => {
    if (dragging) void sceneRef.current?.prepareAsset(dragging);
    if (!dragging && !placingAssetId) {
      sceneRef.current?.showPlacementPreview(undefined, undefined);
      if (hostRef.current) hostRef.current.style.cursor = "";
    }
  }, [dragging, placingAssetId]);

  useEffect(() => {
    sceneRef.current?.showPlacementPreview(
      placingAssetId ?? undefined,
      placingAssetId ? [0, 0, 0] : undefined,
    );
    return () => {
      sceneRef.current?.showPlacementPreview(undefined, undefined);
    };
  }, [placingAssetId, status]);

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
      id === "test-room-module-v1" ||
      assets.some((asset) => asset.id === id && asset.kind === "environment")
    );
  }
  function accepts(event: DragEvent) {
    return (
      dragging &&
      editingEnabled &&
      status === "ready" &&
      sceneRef.current?.modeManager.getState().mode === "editor" &&
      event.dataTransfer.types.includes(assetDragType)
    );
  }

  return (
    <section className="viewport" id="viewport" tabIndex={-1} aria-label="Scene">
      <div
        className={`viewport-stage${dragging ? " is-dragging" : ""}`}
        style={{ pointerEvents: status === "loading" ? "none" : undefined }}
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
            const valid = scene?.showPlacementPreview(
              placingAssetId,
              scene.getDropPosition(
                event.clientX,
                event.clientY,
                isRoom(placingAssetId),
                placingAssetId,
              ),
              scene.pickObjectAt(event.clientX, event.clientY),
            );
            event.currentTarget.style.cursor = valid ? "crosshair" : "not-allowed";
          }
        }}
        onPointerLeave={() => {
          if (textPlacement) sceneRef.current?.clearTextPlacement();
          if (placingAssetId) sceneRef.current?.showPlacementPreview(placingAssetId, undefined);
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
            status !== "ready" ||
            sceneRef.current?.modeManager.getState().mode !== "editor"
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (event.button !== 0) {
            onPlacementCancel?.();
            return;
          }
          const position = sceneRef.current.getDropPosition(
            event.clientX,
            event.clientY,
            isRoom(placingAssetId),
            placingAssetId,
          );
          if (position) {
            if (
              isRoom(placingAssetId) &&
              !sceneRef.current.showPlacementPreview(placingAssetId, position)
            )
              return;
            const objectId = sceneRef.current.pickObjectAt(event.clientX, event.clientY);
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
            scene?.showPlacementPreview(
              HOTSPOT_ASSET_ID,
              anchor === undefined ? undefined : [0, 0, 0],
              objectId ?? undefined,
            );
            return;
          }
          const position = sceneRef.current?.getDropPosition(
            event.clientX,
            event.clientY,
            isRoom(dragging),
            dragging ?? undefined,
          );
          const valid = sceneRef.current?.showPlacementPreview(dragging ?? undefined, position);
          event.dataTransfer.dropEffect = valid ? "copy" : "none";
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            sceneRef.current?.showPlacementPreview(dragging ?? undefined, undefined);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const assetId = event.dataTransfer.getData(assetDragType);
          if (accepts(event) && assets.some((asset) => asset.id === assetId)) {
            const scene = sceneRef.current;
            if (assetId === HOTSPOT_ASSET_ID) {
              const objectId = scene?.pickObjectAt(event.clientX, event.clientY);
              onPlace(assetId, [0, 0, 0], objectId === undefined ? undefined : { objectId });
            } else {
              const position = scene?.getDropPosition(
                event.clientX,
                event.clientY,
                isRoom(assetId),
                assetId,
              );
              if (position !== undefined && scene?.showPlacementPreview(assetId, position))
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
          <a href="/login?returnTo=%2F" target="_blank" rel="noopener noreferrer">
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
