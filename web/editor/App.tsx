import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assets } from "virtual:asset-catalogue";
import { assetDragType } from "../shared/assets/catalogue";
import type { Vector3Tuple } from "../shared/project/scene-object";
import type { Transform } from "../shared/project/project-types";
import { createDocumentStore } from "./document-store";
import type { ViewportStatus } from "./graphics/scene";
import { Viewport } from "./viewport/Viewport";
import sampleProject from "../shared/project/fixtures/m1-project.json";

import type { ProjectDocument } from "../shared/project/project-types";
import { loadLocalDraft, saveLocalDraft } from "./persistence/local-drafts";
import { serializeProject } from "../shared/project/project-serialization";
import { deserializeProject } from "../shared/project/project-deserialization";
import { MAX_PROJECT_BYTES } from "../shared/project/project-limits";

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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [savedProject, setSavedProject] = useState<ProjectDocument | null>(null);
  const [storageOperation, setStorageOperation] = useState<"save" | "recover" | "import" | null>(
    null,
  );
  const [saveFailed, setSaveFailed] = useState(false);
  // revision follows confirmed storage writes; editSequence follows changes in this tab
  // busy blocks another save or recovery immediately, before React redraws the buttons
  const local = useRef({
    revision: 0,
    editSequence: 0,
    busy: false,
    noticeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const draftMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Clicking back into the editor closes the project options
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !draftMenu.current?.contains(event.target)) {
        draftMenu.current?.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    const localState = local.current;
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      clearTimeout(localState.noticeTimer);
    };
  }, []);
  function closeDraftMenu() {
    draftMenu.current?.removeAttribute("open");
    draftMenu.current?.querySelector("summary")?.focus();
  }
  const selection = objects.some((object) => object.id === selectedId) ? selectedId : null;
  const selectedObject = objects.find((object) => object.id === selection);
  const hasChanges = project !== null || objects.length > 0;

  // Store edits create a new project snapshot
  // Remembering the saved snapshot lets later edits keep the unsaved label
  const hasUnsavedChanges = project !== null ? project !== savedProject : objects.length > 0;

  useEffect(
    () =>
      store.subscribe(() => {
        // Count committed store changes, including undo and redo
        // Selection changes live outside the store and don't create a new edit
        local.current.editSequence += 1;
      }),
    [store],
  );

  async function saveDraft() {
    // Read at click time so the save uses the latest committed scene
    const current = store.getSnapshot().project;
    if (current === null || local.current.busy) return;
    local.current.busy = true;
    setStorageOperation("save");
    setSaveFailed(false);
    setError("");
    const capturedSequence = local.current.editSequence;
    try {
      let expectedRevision = local.current.revision;
      let savedSequence = capturedSequence;
      // Opening the sample starts fresh in memory, but its earlier save may still exist
      // Ask before replacing that copy; the write still checks for edits from another tab
      if (expectedRevision === 0) {
        const existing = await loadLocalDraft(current.projectId, assetKinds);
        if (!existing.ok) {
          setSaveFailed(true);
          setError(existing.error.message);
          return;
        }
        if (existing.value !== null) {
          if (!window.confirm("Replace the existing browser save with this project?")) return;
          expectedRevision = existing.value.localStorageRevision;
          savedSequence = Math.max(capturedSequence, existing.value.localEditSequence + 1);
        }
      }
      const result = await saveLocalDraft(
        {
          project: current,
          expectedStorageRevision: expectedRevision,
          localEditSequence: savedSequence,
        },
        assetKinds,
      );
      if (!result.ok) {
        // Keep the last confirmed revision so a failed write doesn't advance our counter
        setSaveFailed(true);
        setError(result.error.message);
        return;
      }
      local.current.revision = result.value.localStorageRevision;
      // Carry the new counter baseline forward while retaining edits made during the write
      local.current.editSequence += savedSequence - capturedSequence;
      // Only this captured snapshot was saved; later edits still need another write
      setSavedProject(current);
      setNotice("Local draft saved on this device");
    } catch {
      setSaveFailed(true);
      setError("Local save failed; your current scene is still open");
    } finally {
      // Release the controls after success, rejection or an unexpected storage error
      local.current.busy = false;
      setStorageOperation(null);
    }
  }

  function exportProject() {
    const current = store.getSnapshot().project;
    if (current === null || local.current.busy) return;
    setError("");
    // Use the same checked JSON as browser saving so both copies describe the same scene
    const result = serializeProject(current, assetKinds);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      const file = new Blob([result.value], { type: "application/json;charset=utf-8" });
      url = URL.createObjectURL(file);
      link.href = url;
      // Prefix avoids reserved filenames; strip characters that Windows treats as paths
      const name = current.title
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      link.download = `vthere-${name || "project"}.json`;
      document.body.append(link);
      link.click();
      // Browser owns the download from here; this doesn't confirm a browser-storage save
      setNotice("Project download started");
    } catch {
      setError("Could not export the project; your scene is still open");
    } finally {
      link.remove();
      // Give the browser time to begin reading before releasing the temporary file URL
      if (url !== undefined) {
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
      }
    }
  }

  async function importProject(file: File) {
    if (local.current.busy) return;
    setError("");
    // Check the file size before allocating its text in memory
    if (file.size > MAX_PROJECT_BYTES) {
      setError("Project JSON exceeds the 5 MiB file limit");
      return;
    }
    const before = store.getSnapshot();
    local.current.busy = true;
    setStorageOperation("import");
    try {
      const text = await file.text();
      const checked = deserializeProject(text, assetKinds);
      if (!checked.ok) {
        setError(checked.error.message);
        return;
      }
      // A file read can finish after another edit; leave those newer changes alone
      if (store.getSnapshot() !== before) {
        setError("The scene changed while reading the file; import it again when ready");
        return;
      }
      // Ask only after validation so a broken file never prompts us to discard good work
      if (hasUnsavedChanges && !window.confirm("Replace unsaved changes with this project file?"))
        return;
      const loaded = store.loadProject(text, assetKinds);
      if (!loaded.ok) {
        setError(loaded.error.message);
        return;
      }
      // Import opens a file copy; any existing browser save needs explicit replacement later
      local.current.revision = 0;
      local.current.editSequence = 0;
      clearTimeout(local.current.noticeTimer);
      setSavedProject(null);
      setSaveFailed(false);
      setSelectedId(null);
      setDragging(false);
      setNotice("Project imported");
    } catch {
      setError("Could not read the project file; your scene is unchanged");
    } finally {
      local.current.busy = false;
      setStorageOperation(null);
    }
  }

  async function recoverDraft() {
    if (local.current.busy) return;
    if (hasUnsavedChanges && !window.confirm("Replace unsaved changes with the local draft?"))
      return;
    // Keep the starting snapshot to detect edits made while IndexedDB is reading
    const before = store.getSnapshot();
    local.current.busy = true;
    setStorageOperation("recover");
    setError("");
    try {
      // Recover the open project's copy; the sample remains the startup default
      const projectId = before.project?.projectId ?? sampleProject.projectId;
      const result = await loadLocalDraft(projectId, assetKinds);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (result.value === null) {
        // First visit or cleared browser storage; leave whatever is open alone
        setNotice("No local draft found for this project on this device");
        return;
      }
      // A slow read must never replace edits made after recovery started
      if (store.getSnapshot() !== before) {
        setError("The scene changed while reading the draft; choose Recover again when ready");
        return;
      }
      // Store replacement clears old undo history and freezes the recovered data
      const restored = store.loadProject(JSON.stringify(result.value.document), assetKinds);
      if (!restored.ok) {
        setError(restored.error.message);
        return;
      }
      // Continue from the recovered counters so the next save targets this exact draft
      local.current.revision = result.value.localStorageRevision;
      local.current.editSequence = result.value.localEditSequence;
      setSavedProject(restored.value);
      setSaveFailed(false);
      // Selection and drag feedback belong to the scene that was just replaced
      setSelectedId(null);
      setDragging(false);
      setNotice("Recovered local draft from this device");
    } catch {
      setError("Local recovery failed; your current scene is unchanged");
    } finally {
      local.current.busy = false;
      setStorageOperation(null);
    }
  }

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
    if (local.current.busy) return;
    if (hasChanges && !window.confirm("Replace the current scene? Unsaved changes will be lost.")) {
      return;
    }
    // Exercise the same reader used by file import
    // Failed validation leaves selection and the current scene alone
    const result = store.loadProject(JSON.stringify(sampleProject), assetKinds);
    if (!result.ok) {
      setError(`${result.error.path}: ${result.error.message}`);
      return;
    }
    // Opening the original sample must not silently overwrite a stored draft
    // Save will check for an earlier copy and ask before replacing it
    local.current.revision = 0;
    local.current.editSequence = 0;
    setSavedProject(null);
    setSaveFailed(false);
    setSelectedId(null);
    setDragging(false);
    setError("");
    setNotice("Opened sample project");
  }

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      // Browser owns the warning dialog; saving still happens through Save locally
      event.preventDefault();
    }
    addEventListener("beforeunload", warnBeforeLeaving);
    // Remove the warning when the current snapshot has been saved
    return () => removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedChanges]);

  function place(assetId: string, position: Vector3Tuple) {
    const result = store.addObject(assetId, position);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    const addedNotice = `Added ${result.object.name}`;
    setNotice(addedNotice);
    // Give the latest placement three seconds; keep newer save or recovery feedback
    clearTimeout(local.current.noticeTimer);
    local.current.noticeTimer = setTimeout(() => {
      setNotice((current) => (current === addedNotice ? "" : current));
    }, 3000);
  }

  return (
    <div className="editor-shell">
      <a className="skip-link" href="#viewport">
        Skip to scene
      </a>
      <header className="app-header">
        {/* Project actions stay behind this icon so the library has room for assets */}
        <details
          className="draft-menu"
          ref={draftMenu}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeDraftMenu();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              event.currentTarget.removeAttribute("open");
          }}
        >
          <summary aria-label="Project options" title="Project options">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </summary>
          <div className="draft-menu-panel">
            <button
              type="button"
              aria-label="Save locally"
              title="Save a copy in this browser"
              disabled={project === null || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void saveDraft();
              }}
            >
              Save
            </button>
            <button
              type="button"
              aria-label="Recover local draft"
              title="Restore your last local save"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void recoverDraft();
              }}
            >
              Recover
            </button>
            <button
              type="button"
              title="Download this project as a JSON file"
              disabled={project === null || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                exportProject();
              }}
            >
              Export
            </button>
            <button
              type="button"
              title="Open a JSON project file"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                document.getElementById("project-import")?.click();
              }}
            >
              Import
            </button>
          </div>
        </details>
        <h1>
          <strong>VThere</strong> Spatial Experience Editor
        </h1>
        <div className="history-controls" role="group" aria-label="History">
          {import.meta.env.DEV && (
            <button
              type="button"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={openSampleProject}
            >
              Open sample project
            </button>
          )}
          <button type="button" disabled={!canUndo} onClick={store.undo}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" />
            </svg>
            Undo
          </button>
          <button type="button" disabled={!canRedo} onClick={store.redo}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />
            </svg>
            Redo
          </button>
        </div>
        {hasChanges && (
          <span className="save-state" title="Local drafts belong to this browser on this device">
            {storageOperation === "save"
              ? "Saving locally…"
              : saveFailed
                ? "Local save failed"
                : hasUnsavedChanges
                  ? "Not saved"
                  : "Saved on this device"}
          </span>
        )}
      </header>
      {/* Reset the input so choosing the same file again still fires a change */}
      <input
        id="project-import"
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) void importProject(file);
        }}
      />

      <main className="workspace">
        <aside className="library" aria-label="Assets and scene objects">
          <section aria-labelledby="assets-heading">
            <h2 id="assets-heading">Asset library</h2>
            <ul className="asset-shelf" role="list">
              {assets
                .filter((asset) => project === null || asset.kind === "model")
                .map((asset) => (
                  <li key={asset.id}>
                    <button
                      className="asset-tile"
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
                      <span className="asset-art">
                        <img src={thumbnailFor(asset.id)} alt="" draggable={false} />
                        <span className="asset-add" aria-hidden="true">
                          +
                        </span>
                      </span>
                      <span className="asset-name">{asset.name}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>

          {hasChanges && (
            <section className="scene-objects" aria-labelledby="objects-heading">
              <h2 id="objects-heading">
                In this scene <span>{objects.length}</span>
              </h2>
              <ul role="list">
                {objects.map((object) => (
                  <li key={object.id}>
                    <button
                      className="object-row"
                      type="button"
                      aria-pressed={selection === object.id}
                      data-object-id={object.id}
                      onClick={() => setSelectedId(object.id)}
                    >
                      <img src={thumbnailFor(object.assetId)} alt="" draggable={false} />
                      <span>{object.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {selectedObject !== undefined && (
                <div
                  className="move-controls"
                  role="group"
                  aria-label={`Move ${selectedObject.name}`}
                >
                  <p>Move selected · 0.25 m per step</p>
                  <div>
                    {([0, 1, 2] as const).map((axis) =>
                      ([-0.25, 0.25] as const).map((delta) => (
                        <button
                          key={`${axis}:${delta}`}
                          type="button"
                          aria-label={`Move ${selectedObject.name} ${"XYZ"[axis]} ${delta > 0 ? "plus" : "minus"} 0.25 metres`}
                          onClick={() => moveSelected(axis, delta)}
                        >
                          {"XYZ"[axis]} {delta > 0 ? "+" : "−"}
                        </button>
                      )),
                    )}
                  </div>
                  <output aria-label="Selected position">
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
        />
      </main>
      <p className="draft-feedback" role="status">
        {storageOperation === "recover"
          ? "Reading local draft…"
          : storageOperation === "import"
            ? "Reading project file…"
            : notice}
      </p>
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
