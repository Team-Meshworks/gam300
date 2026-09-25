import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { assets } from "virtual:asset-catalogue";
import { assetDragType } from "../shared/assets/catalogue";
import type { Vector3Tuple } from "../shared/project/scene-object";
import { LeftSidebar } from "./left-sidebar/LeftSidebar";
import type { Transform } from "../shared/project/project-types";
import { createDocumentStore } from "./document-store";
import type { ViewportStatus } from "./graphics/scene";
import type { ModeManager, ModeManagerState } from "./graphics/modeManager";
import { Viewport } from "./viewport/Viewport";
import sampleProject from "../shared/project/fixtures/m1-project.json";

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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manager, setManager] = useState<ModeManager | null>(null);
  const [modeState, setModeState] = useState<ModeManagerState | null>(null);
  const selection = objects.some((object) => object.id === selectedId) ? selectedId : null;
  const selectedObject = objects.find((object) => object.id === selection);
  const hasChanges = project !== null || objects.length > 0;
  const visitor = modeState?.mode === "visitor";

  const onManager = useCallback((next: ModeManager) => {
    setManager(next);
    setModeState(next.getState());
  }, []);

  useEffect(() => (manager === null ? undefined : manager.subscribe(setModeState)), [manager]);

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
    [store],
  );

  function moveSelected(axis: 0 | 1 | 2, delta: number) {
    if (selectedObject === undefined) return;
    const position = [...selectedObject.transform.position] as [number, number, number];
    position[axis] += delta;
    onTransform(selectedObject.id, { ...selectedObject.transform, position });
  }

  function openSampleProject() {
    if (hasChanges && !window.confirm("Replace the current scene? Unsaved changes will be lost.")) {
      return;
    }
    // Exercise the same reader used by file import later
    // Failed validation leaves selection and the current scene alone
    const result = store.loadProject(JSON.stringify(sampleProject), assetKinds);
    if (!result.ok) {
      setError(`${result.error.path}: ${result.error.message}`);
      return;
    }
    setSelectedId(null);
    setDragging(false);
    setError("");
    setNotice("Opened sample project");
  }

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

  function place(assetId: string, position: Vector3Tuple) {
    const result = store.addObject(assetId, position);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    setNotice(`Added ${result.object.name}.`);
  }

  return (
    <div className="flex h-dvh flex-col">
      <a
        className="fixed top-2 left-2 z-[5] -translate-y-[200%] bg-ink p-3 text-white focus:translate-y-0"
        href="#viewport"
      >
        Skip to scene
      </a>
      <header className="flex min-h-16 items-center gap-7 border-b border-line px-6 py-2 max-[760px]:flex-wrap max-[760px]:gap-x-4 max-[760px]:gap-y-1 max-[760px]:px-4 max-[760px]:py-[0.6rem] min-[1600px]:min-h-[clamp(2rem,3vw,3.75rem)] min-[1600px]:gap-[clamp(0.875rem,1.375vw,1.75rem)] min-[1600px]:px-[clamp(0.75rem,1.5vw,2.25rem)] min-[1600px]:py-[clamp(0.25rem,0.5vw,0.625rem)]">
        <h1 className="max-[760px]:basis-full text-base font-[450] tracking-[-0.02em] min-[1600px]:text-[clamp(0.5rem,0.85vw,1.125rem)]">
          <strong className="font-[750]">VThere</strong> Spatial Experience Editor
        </h1>
        <div className="ml-auto flex gap-1 max-[760px]:ml-0" role="group" aria-label="History">
          {import.meta.env.DEV && (
            <button
              type="button"
              className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] px-[0.7rem] py-[0.4rem] text-[0.8125rem] hover:bg-surface disabled:text-muted-soft min-[1600px]:min-h-[clamp(1.375rem,2.125vw,2.875rem)] min-[1600px]:gap-[0.2rem] min-[1600px]:rounded-[0.15rem] min-[1600px]:px-[clamp(0.35rem,0.6vw,0.8rem)] min-[1600px]:py-[0.2rem] min-[1600px]:text-[clamp(0.40625rem,0.6vw,0.75rem)]"
              disabled={status !== "ready"}
              onClick={openSampleProject}
            >
              Open sample project
            </button>
          )}
          <button
            type="button"
            className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] px-[0.7rem] py-[0.4rem] text-[0.8125rem] hover:bg-surface disabled:text-muted-soft min-[1600px]:min-h-[clamp(1.375rem,2.125vw,2.875rem)] min-[1600px]:gap-[0.2rem] min-[1600px]:rounded-[0.15rem] min-[1600px]:px-[clamp(0.35rem,0.6vw,0.8rem)] min-[1600px]:py-[0.2rem] min-[1600px]:text-[clamp(0.40625rem,0.6vw,0.75rem)]"
            disabled={!canUndo}
            onClick={store.undo}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 fill-none stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round] min-[1600px]:size-2"
            >
              <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" />
            </svg>
            Undo
          </button>
          <button
            type="button"
            className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] px-[0.7rem] py-[0.4rem] text-[0.8125rem] hover:bg-surface disabled:text-muted-soft min-[1600px]:min-h-[clamp(1.375rem,2.125vw,2.875rem)] min-[1600px]:gap-[0.2rem] min-[1600px]:rounded-[0.15rem] min-[1600px]:px-[clamp(0.35rem,0.6vw,0.8rem)] min-[1600px]:py-[0.2rem] min-[1600px]:text-[clamp(0.40625rem,0.6vw,0.75rem)]"
            disabled={!canRedo}
            onClick={store.redo}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 fill-none stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round] min-[1600px]:size-2"
            >
              <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />
            </svg>
            Redo
          </button>
        </div>
        {manager !== null && (
          <div className="flex gap-1" role="group" aria-label="Camera mode">
            {visitor ? (
              <button
                type="button"
                className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] border border-line bg-paper px-[0.9rem] py-[0.4rem] text-[0.8125rem] enabled:hover:border-line-strong enabled:hover:bg-surface min-[1600px]:min-h-[clamp(1.375rem,2.125vw,2.875rem)] min-[1600px]:gap-[0.2rem] min-[1600px]:rounded-[0.15rem] min-[1600px]:px-[clamp(0.45rem,0.85vw,1.125rem)] min-[1600px]:py-[0.2rem] min-[1600px]:text-[clamp(0.40625rem,0.6vw,0.75rem)]"
                onClick={() => manager.setMode("editor")}
              >
                Exit Visitor
              </button>
            ) : (
              <button
                type="button"
                className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] border border-line bg-paper px-[0.9rem] py-[0.4rem] text-[0.8125rem] enabled:hover:border-line-strong enabled:hover:bg-surface min-[1600px]:min-h-[clamp(1.375rem,2.125vw,2.875rem)] min-[1600px]:gap-[0.2rem] min-[1600px]:rounded-[0.15rem] min-[1600px]:px-[clamp(0.45rem,0.85vw,1.125rem)] min-[1600px]:py-[0.2rem] min-[1600px]:text-[clamp(0.40625rem,0.6vw,0.75rem)]"
                onClick={() => manager.setMode("visitor")}
              >
                Enter Visitor
              </button>
            )}
          </div>
        )}
        {hasChanges && (
          <span
            className="max-[760px]:ml-auto whitespace-nowrap text-xs text-muted min-[1600px]:text-[clamp(0.375rem,0.5vw,0.625rem)]"
            title="Changes last until you close or reload this page."
          >
            <span className="mr-2 inline-block size-[0.35rem] rounded-full bg-amber" aria-hidden="true" />
            Not saved
          </span>
        )}
      </header>

      <main className="grid min-h-0 flex-1 bg-view grid-cols-[minmax(400px,16vw)_minmax(0,1fr)] max-[760px]:grid-cols-[minmax(0,1fr)]">
        <LeftSidebar
          assets={assets}
          objects={objects}
          hasProject={project !== null}
          selectedId={selection}
          selectedObject={selectedObject}
          status={status}
          thumbnailFor={thumbnailFor}
          onSelect={(id) => setSelectedId(id)}
          onPlace={place}
          onMoveSelected={moveSelected}
          onDragStart={(assetId, event) => {
            event.dataTransfer.setData(assetDragType, assetId);
            event.dataTransfer.effectAllowed = "copy";
            setDragging(true);
          }}
          onDragEnd={() => setDragging(false)}
        />

        <Viewport
          assets={assets}
          objects={objects}
          projectScene={project?.scenes[0] ?? null}
          selectedId={selection}
          dragging={dragging}
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
      <p className="sr-only" role="status">
        {notice}
      </p>
      {error && (
        <p className="fixed bottom-4 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 bg-danger px-4 py-3 text-white" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
