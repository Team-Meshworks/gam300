import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { assets } from "virtual:asset-catalogue";
import { assetDragType } from "../shared/assets/catalogue";
import type { Vector3Tuple } from "../shared/project/scene-object";
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
      <header className="flex min-h-16 items-center gap-7 border-b border-line px-6 py-2 max-[760px]:flex-wrap max-[760px]:gap-x-4 max-[760px]:gap-y-1 max-[760px]:px-4 max-[760px]:py-[0.6rem]">
        <h1 className="max-[760px]:basis-full text-base font-[450] tracking-[-0.02em]">
          <strong className="font-[750]">VThere</strong> Spatial Experience Editor
        </h1>
        <div className="ml-auto flex gap-1 max-[760px]:ml-0" role="group" aria-label="History">
          {import.meta.env.DEV && (
            <button
              type="button"
              className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] px-[0.7rem] py-[0.4rem] text-[0.8125rem] hover:bg-surface disabled:text-muted-soft"
              disabled={status !== "ready"}
              onClick={openSampleProject}
            >
              Open sample project
            </button>
          )}
          <button
            type="button"
            className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] px-[0.7rem] py-[0.4rem] text-[0.8125rem] hover:bg-surface disabled:text-muted-soft"
            disabled={!canUndo}
            onClick={store.undo}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 fill-none stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round]"
            >
              <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" />
            </svg>
            Undo
          </button>
          <button
            type="button"
            className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] px-[0.7rem] py-[0.4rem] text-[0.8125rem] hover:bg-surface disabled:text-muted-soft"
            disabled={!canRedo}
            onClick={store.redo}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 fill-none stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round]"
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
                className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] border border-line bg-paper px-[0.9rem] py-[0.4rem] text-[0.8125rem] enabled:hover:border-line-strong enabled:hover:bg-surface"
                onClick={() => manager.setMode("editor")}
              >
                Exit Visitor
              </button>
            ) : (
              <button
                type="button"
                className="flex min-h-[2.75rem] items-center gap-[0.4rem] rounded-[0.3rem] border border-line bg-paper px-[0.9rem] py-[0.4rem] text-[0.8125rem] enabled:hover:border-line-strong enabled:hover:bg-surface"
                onClick={() => manager.setMode("visitor")}
              >
                Enter Visitor
              </button>
            )}
          </div>
        )}
        {hasChanges && (
          <span
            className="max-[760px]:ml-auto whitespace-nowrap text-xs text-muted"
            title="Changes last until you close or reload this page."
          >
            <span className="mr-2 inline-block size-[0.35rem] rounded-full bg-amber" aria-hidden="true" />
            Not saved
          </span>
        )}
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] max-[760px]:grid-cols-[minmax(0,1fr)]">
        <aside
          className="border-r border-line px-5 py-[1.6rem] overflow-y-auto max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:border-line max-[760px]:p-4"
          aria-label="Assets and scene objects"
        >
          <section aria-labelledby="assets-heading">
            <h2 id="assets-heading" className="text-[0.9375rem] font-[650] tracking-[-0.015em]">
              Asset library
            </h2>
            <ul
              className="mt-[1.2rem] grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4 max-[760px]:grid-cols-[repeat(auto-fill,minmax(8rem,10rem))]"
              role="list"
            >
              {assets
                .filter((asset) => project === null || asset.kind === "model")
                .map((asset) => (
                  <li key={asset.id}>
                    <button
                      className="group block w-full cursor-grab p-0 text-left active:cursor-grabbing"
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
                      <span
                        className="relative grid aspect-[1.1] place-items-center rounded-2xl border border-transparent bg-art transition-[background,transform] duration-150 group-enabled:hover:-translate-y-[3px] group-enabled:hover:bg-art-hover group-focus-visible:-translate-y-[3px] group-focus-visible:bg-art-hover motion-reduce:transition-none motion-reduce:group-enabled:hover:transform-none motion-reduce:group-focus-visible:transform-none"
                        data-testid="asset-art"
                      >
                        <img
                          src={thumbnailFor(asset.id)}
                          alt=""
                          draggable={false}
                          className="size-full object-contain pointer-events-none"
                        />
                        <span
                          className="absolute right-[0.65rem] bottom-[0.65rem] grid size-7 place-items-center rounded-[0.35rem] bg-paper text-[1.3rem] leading-none"
                          aria-hidden="true"
                        >
                          +
                        </span>
                      </span>
                      <span className="block px-[0.2rem] pt-[0.65rem] text-sm font-[550]">
                        {asset.name}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>

          {hasChanges && (
            <section
              className="mt-8 border-t border-line pt-5 max-[760px]:mt-4"
              aria-labelledby="objects-heading"
            >
              <h2
                id="objects-heading"
                className="mb-3 flex justify-between text-[0.9375rem] font-[650] tracking-[-0.015em]"
              >
                In this scene <span className="font-normal tabular-nums text-muted">{objects.length}</span>
              </h2>
              <ul role="list">
                {objects.map((object) => (
                  <li key={object.id}>
                    <button
                      className="flex min-h-[2.75rem] w-full items-center gap-2 border-l-2 border-l-transparent bg-transparent px-2 py-[0.3rem] text-left text-[0.8125rem] hover:bg-tint-hover aria-pressed:border-l-sel aria-pressed:bg-tint"
                      type="button"
                      data-testid="object-row"
                      aria-pressed={selection === object.id}
                      data-object-id={object.id}
                      onClick={() => setSelectedId(object.id)}
                    >
                      <img
                        src={thumbnailFor(object.assetId)}
                        alt=""
                        draggable={false}
                        className="size-8 object-contain"
                      />
                      <span>{object.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {selectedObject !== undefined && (
                <div
                  className="mt-[0.9rem] rounded-lg border border-line p-[0.8rem] text-xs"
                  role="group"
                  aria-label={`Move ${selectedObject.name}`}
                >
                  <p>Move selected · 0.25 m per step</p>
                  <div className="my-[0.6rem] grid grid-cols-3 gap-[0.4rem]">
                    {([0, 1, 2] as const).map((axis) =>
                      ([-0.25, 0.25] as const).map((delta) => (
                        <button
                          key={`${axis}:${delta}`}
                          type="button"
                          className="min-h-[2.75rem] rounded-[0.3rem] border border-edge bg-white hover:bg-tint"
                          aria-label={`Move ${selectedObject.name} ${"XYZ"[axis]} ${delta > 0 ? "plus" : "minus"} 0.25 metres`}
                          onClick={() => moveSelected(axis, delta)}
                        >
                          {"XYZ"[axis]} {delta > 0 ? "+" : "−"}
                        </button>
                      )),
                    )}
                  </div>
                  <output aria-label="Selected position" className="block tabular-nums text-muted">
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
