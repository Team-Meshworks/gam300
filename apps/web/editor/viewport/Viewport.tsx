import { useEffect, useRef, type DragEvent, type ReactNode } from "react";
import { assetDragType, type CatalogueAsset } from "../../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type { ProjectScene, Transform, CameraPose } from "../../shared/project/project-types";
import type { initScene, NavigationTool, ViewportStatus } from "../graphics/scene";
import type { ModeManager } from "../graphics/modeManager";

const statusMessages = {
  loading: "Loading assets…",
  ready: "Scene ready",
  error: "Couldn't load the 3D view. Check your connection and retry.",
  "download-error": "Couldn't start the 3D view. Reload the editor to try again.",
  unsupported: "The 3D view needs WebGL 2. Check your browser's graphics settings and retry.",
};

export type ViewpointCamera = { capture: () => CameraPose; show: (pose: CameraPose) => void };

type ViewportProps = {
  onCamera: (camera: ViewpointCamera | null) => void;
  assets: readonly CatalogueAsset[];
  objects: readonly SceneObject[];
  projectScene: ProjectScene | null;
  selectedId: string | null;
  dragging: boolean;
  editingEnabled: boolean;
  navigationTool: NavigationTool;
  status: ViewportStatus;
  attempt: number;
  onStatus: (status: ViewportStatus) => void;
  onThumbnail: (id: string, url: string) => void;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, transform: Transform) => void;
  onPlace: (assetId: string, position: Vector3Tuple) => void;
  onDragFinish: () => void;
  onRetry: () => void;
  onManager: (manager: ModeManager) => void;
  children?: ReactNode;
};

export function Viewport({
  onCamera,
  assets,
  objects,
  projectScene,
  selectedId,
  dragging,
  editingEnabled,
  navigationTool,
  status,
  attempt,
  onStatus,
  onThumbnail,
  onSelect,
  onTransform,
  onPlace,
  onDragFinish,
  onRetry,
  onManager,
  children,
}: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ReturnType<typeof initScene>>(undefined);
  const snapshotRef = useRef({ objects, selectedId, projectScene, editingEnabled, navigationTool });

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
        const scene = initScene(host, assets, { onStatus, onThumbnail, onSelect, onTransform });
        sceneRef.current = scene;
        const current = snapshotRef.current;
        scene?.update(current.objects, current.selectedId, current.projectScene);
        scene?.setEditingEnabled(current.editingEnabled);
        scene?.setNavigationTool(current.navigationTool);
        if (scene !== undefined) {
          onManager(scene.modeManager);
          onCamera({ capture: scene.captureCamera, show: scene.showCamera });
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
      sceneRef.current?.dispose();
      sceneRef.current = undefined;
    };
  }, [assets, attempt, onStatus, onThumbnail, onSelect, onTransform, onManager, onCamera]);

  useEffect(() => {
    snapshotRef.current = { objects, selectedId, projectScene, editingEnabled, navigationTool };
    sceneRef.current?.update(objects, selectedId, projectScene);
    sceneRef.current?.setEditingEnabled(editingEnabled);
    sceneRef.current?.setNavigationTool(navigationTool);
  }, [objects, selectedId, projectScene, editingEnabled, navigationTool, assets, attempt]);

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
        onDragOver={(event) => {
          if (!accepts(event)) {
            return;
          }
          event.preventDefault();
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
            const position = sceneRef.current?.getDropPosition(event.clientX, event.clientY);
            if (position !== undefined) {
              onPlace(assetId, position);
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
