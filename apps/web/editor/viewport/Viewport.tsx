import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { placeRoom } from "../../shared/project/room-placement";
import { assetDragType, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
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
  draggedAssetId: string | null;
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
  draggedAssetId,
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
  const [dropFeedback, setDropFeedback] = useState<{
    text: string;
    tone: "neutral" | "snapped" | "invalid";
  }>({ text: "Drop to place", tone: "neutral" });
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

  function previewDrop(clientX: number, clientY: number, assetId: string | null) {
    const raw = sceneRef.current?.getDropPosition(clientX, clientY);
    const asset = assets.find((a) => a.id === assetId);
    if (!raw || !asset?.room) {
      sceneRef.current?.showDropPosition(raw);
      setDropFeedback({ text: "Drop to place", tone: "neutral" });
      return raw;
    }
    const result = placeRoom(asset.id, raw, assets, objects, projectScene);
    sceneRef.current?.showDropPosition(result.position, {
      ...asset.room,
      valid: result.valid,
      snapped: result.snapped,
    });
    setDropFeedback({
      tone: !result.valid ? "invalid" : result.snapped === "room" ? "snapped" : "neutral",
      text: !result.valid
        ? "Rooms cannot overlap"
        : result.snapped === "room"
          ? "Snapped to room edge"
          : "Snapped to grid · floor Y = 0",
    });
    return result.valid ? result.position : undefined;
  }

  return (
    <section className="viewport" id="viewport" tabIndex={-1} aria-label="Scene">
      {assets.map((asset) => (
        <link key={asset.id} rel="preload" as="fetch" href={asset.url} crossOrigin="anonymous" />
      ))}
      <div
        className={`viewport-stage${dragging ? ` is-dragging is-${dropFeedback.tone}` : ""}`}
        ref={hostRef}
        aria-busy={status === "loading"}
        onDragOver={(event) => {
          if (!accepts(event)) {
            return;
          }
          event.preventDefault();
          const position = previewDrop(event.clientX, event.clientY, draggedAssetId);
          event.dataTransfer.dropEffect = position === undefined ? "none" : "copy";
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
            const position = previewDrop(event.clientX, event.clientY, assetId);
            if (position !== undefined) {
              onPlace(assetId, position);
            }
          }
          sceneRef.current?.showDropPosition(undefined);
          onDragFinish();
        }}
      />
      {children}
      {dragging && (
        <p className={`drop-cue is-${dropFeedback.tone}`} role="status">
          {dropFeedback.text}
        </p>
      )}
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
