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
};

export type ViewpointCamera = {
  capture: () => CameraPose;
  show: (pose: CameraPose) => void;
  locate: (id: string) => void;
  toggleDisplayMedia: (id: string) => void;
  hotspotAnchor: (id: string) => Vector3Tuple | undefined;
};

type ViewportProps = {
  onCamera: (camera: ViewpointCamera | null) => void;
  assets: readonly CatalogueAsset[];
  objects: readonly SceneObject[];
  projectScene: ProjectScene | null;
  loadGeneration: number;
  selectedId: string | null;
  dragging: string | null;
  placingAssetId?: string | null;
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
  onPlace: (assetId: string, position: Vector3Tuple, hotspotTarget?: HotspotDropTarget) => void;
  onDragFinish: () => void;
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
  dragging,
  placingAssetId,
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
        );
        scene?.setEditingEnabled(current.editingEnabled);
        scene?.setNavigationTool(current.navigationTool);
        if (scene !== undefined) {
          onManager(scene.modeManager);
          onMobileControls(scene.mobileControls);
          onCamera({
            capture: scene.captureCamera,
            show: scene.showCamera,
            locate: scene.locateObject,
            toggleDisplayMedia: scene.toggleDisplayMedia,
            hotspotAnchor: scene.getHotspotAnchor,
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
      projectScene,
      loadGeneration,
      editingEnabled,
      navigationTool,
      view,
    };
    sceneRef.current?.update(objects, selectedId, projectScene, loadGeneration);
    sceneRef.current?.setEditingEnabled(editingEnabled);
    sceneRef.current?.setNavigationTool(navigationTool);
    sceneRef.current?.modeManager.setView(view);
  }, [
    objects,
    selectedId,
    projectScene,
    loadGeneration,
    editingEnabled,
    navigationTool,
    view,
    assets,
    attempt,
  ]);

  useEffect(() => {
    if (!dragging) {
      sceneRef.current?.showDropPosition(undefined);
    }
  }, [dragging]);

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
      {assets.map((asset) => (
        <link key={asset.id} rel="preload" as="fetch" href={asset.url} crossOrigin="anonymous" />
      ))}
      <div
        className={`viewport-stage${dragging ? " is-dragging" : ""}`}
        ref={hostRef}
        aria-busy={status === "loading"}
        onPointerDownCapture={(event) => {
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
          const position = sceneRef.current.getDropPosition(event.clientX, event.clientY);
          if (position) onPlace(placingAssetId, position);
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
            // A floor marker would imply an arbitrary position; attachment uses the owner.
            scene?.showDropPosition(undefined);
            return;
          }
          const position = sceneRef.current?.getDropPosition(event.clientX, event.clientY);
          event.dataTransfer.dropEffect = position === undefined ? "none" : "copy";
          sceneRef.current?.showDropPosition(position);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            sceneRef.current?.showDropPosition(undefined);
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
              const position = scene?.getDropPosition(event.clientX, event.clientY);
              if (position !== undefined) onPlace(assetId, position);
            }
          }
          sceneRef.current?.showDropPosition(undefined);
          onDragFinish();
        }}
      />
      {children}
      {dragging && <p className="drop-cue">Drop to place</p>}
      <div className={status === "ready" ? "sr-only" : "viewport-feedback"}>
        <p role="status">{statusMessages[status]}</p>
        {(status === "error" || status === "unsupported") && (
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
