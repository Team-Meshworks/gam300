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
import { loadLatestLocalDraft, loadLocalDraft, saveLocalDraft } from "./persistence/local-drafts";
import { serializeProject } from "../shared/project/project-serialization";
import { deserializeProject } from "../shared/project/project-deserialization";
import { MAX_PROJECT_BYTES } from "../shared/project/project-limits";
import { ProjectConfirmation } from "./ProjectConfirmation";
import {
  canPickProjectFiles,
  pickProjectFile,
  pickProjectDestination,
  projectFilename,
  wasPickerCancelled,
  writeProjectFile,
  rememberProjectFile,
  recallProjectFile,
  type ProjectFileHandle,
} from "./persistence/project-files";

// Same catalog used by the viewport; saved references need to resolve here too
const assetKinds = new Map(assets.map((asset) => [asset.id, asset.kind]));

// Wait for a pause in editing before saving; each committed edit restarts the timer
const AUTOSAVE_DELAY_MS = 2_000;

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
  // Browser backup and JSON file can finish saving at different times
  // Keep both snapshots so the header follows the copy that actually finished
  const [savedProject, setSavedProject] = useState<ProjectDocument | null>(null);
  const [storageOperation, setStorageOperation] = useState<
    "save" | "recover" | "import" | "file" | null
  >("recover");
  const [saveFailed, setSaveFailed] = useState(false);
  const [fileSavedProject, setFileSavedProject] = useState<ProjectDocument | null>(null);
  // A freshly created empty room has no authored changes to lose
  // Keep its snapshot separate from file saves so the header never claims it was saved to disk
  const [emptyProject, setEmptyProject] = useState<ProjectDocument | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileFailed, setFileFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<{ message: string; action: string } | null>(
    null,
  );
  // Open waits here while the confirmation is on screen
  // Cancel resolves the same promise without replacing the scene
  const confirmationResult = useRef<((accepted: boolean) => void) | null>(null);
  const askToReplace = useCallback((message: string, action = "Replace") => {
    // Resolve the pending decision once; cancelling leaves snapshots and file handles alone
    return new Promise<boolean>((resolve) => {
      confirmationResult.current = resolve;
      setConfirmation({ message, action });
    });
  }, []);
  function answerConfirmation(accepted: boolean) {
    confirmationResult.current?.(accepted);
    confirmationResult.current = null;
    setConfirmation(null);
  }
  // revision follows confirmed storage writes; editSequence follows changes in this tab
  // busy blocks another save or recovery immediately, before React redraws the buttons
  const local = useRef({
    revision: 0,
    editSequence: 0,
    busy: true,
    // pending remembers edits made during a write; paused requires an explicit save or a fresh page to retry
    pending: false,
    paused: false,
    saveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    noticeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    // File destination and last known disk text travel together
    // Comparing that text prevents us from overwriting edits made in another program
    file: null as ProjectFileHandle | null,
    fileText: "",
    fileSnapshot: null as ProjectDocument | null,
    filePaused: false,
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
      confirmationResult.current?.(false);
      confirmationResult.current = null;
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
  const hasUnsavedChanges = project !== null ? project !== fileSavedProject : objects.length > 0;
  const isUntouchedProject = project !== null && project === emptyProject;
  const shouldWarnBeforeLeaving = hasUnsavedChanges && !isUntouchedProject;
  // Browser recovery can be current while the portable file still needs a write
  const browserHasChanges = project !== null && project !== savedProject;

  const saveDraft = useCallback(
    async function saveDraft(automatic = false) {
      // Read when the queued save starts; several edits may have landed during the delay
      const current = store.getSnapshot().project;
      if (current === null || local.current.busy || (automatic && local.current.paused)) return;
      clearTimeout(local.current.saveTimer);
      local.current.pending = false;
      local.current.busy = true;
      setStorageOperation("save");
      setSaveFailed(false);
      if (!automatic) setError("");
      const capturedSequence = local.current.editSequence;
      // Keep the snapshot and its counter together while IndexedDB opens asynchronously
      try {
        let expectedRevision = local.current.revision;
        let savedSequence = capturedSequence;
        // Opening the sample starts fresh in memory, but its earlier save may still exist
        // Ask before replacing that copy; the write still checks for edits from another tab
        if (expectedRevision === 0) {
          const existing = await loadLocalDraft(current.projectId, assetKinds);
          if (!existing.ok) {
            local.current.paused = true;
            setSaveFailed(true);
            setError(existing.error.message);
            return;
          }
          if (existing.value !== null) {
            // Automatic writes never replace an unopened browser copy without a decision
            if (automatic) {
              local.current.paused = true;
              setNotice(
                "An earlier save exists; choose Save to replace it or refresh to reopen it",
              );
              return;
            }
            if (!(await askToReplace("Replace the earlier browser backup with this project?"))) {
              local.current.paused = true;
              return;
            }
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
          local.current.paused = true;
          setSaveFailed(true);
          setError(result.error.message);
          return;
        }
        local.current.paused = false;
        local.current.revision = result.value.localStorageRevision;
        // Carry the new counter baseline forward while retaining edits made during the write
        local.current.editSequence += savedSequence - capturedSequence;
        // Only this captured snapshot was saved; later edits still need another write
        setSavedProject(current);
        if (!automatic) setNotice("Browser backup saved");
        const handle = local.current.file;
        if (
          handle !== null &&
          current !== local.current.fileSnapshot &&
          !local.current.filePaused
        ) {
          // Background saving checks permission quietly; only a Save click can request it
          try {
            if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
              local.current.filePaused = true;
              setNotice("Browser backup saved; choose Save to allow file updates");
            } else {
              const encoded = serializeProject(current, assetKinds);
              if (encoded.ok) {
                await writeProjectFile(handle, encoded.value, local.current.fileText);
                local.current.fileText = encoded.value;
                local.current.fileSnapshot = current;
                setFileSavedProject(current);
                setFileFailed(false);
                // Remembering the filename is a convenience; failure cannot undo a completed file save
                await rememberProjectFile(current.projectId, handle, encoded.value).catch(
                  () => undefined,
                );
              }
            }
          } catch (error) {
            // File access can fail after the browser backup has already committed
            // Pause file retries until Save gives us another explicit attempt
            local.current.filePaused = true;
            setFileFailed(true);
            setError(
              error instanceof Error
                ? error.message
                : "File save failed; your browser backup was kept",
            );
          }
        }
      } catch {
        local.current.paused = true;
        setSaveFailed(true);
        setError("Local save failed; your current scene is still open");
      } finally {
        // Release the controls after success, rejection or an unexpected storage error
        local.current.busy = false;
        setStorageOperation(null);
        // Only the latest store snapshot needs another write after a slow transaction
        if (local.current.pending && !local.current.paused) {
          local.current.saveTimer = setTimeout(() => void saveDraft(true), AUTOSAVE_DELAY_MS);
        }
      }
    },
    [store, askToReplace],
  );

  useEffect(() => {
    const state = local.current;
    const unsubscribe = store.subscribe(() => {
      // Placement, movement, undo and redo all publish committed store changes
      // The timer reads the latest snapshot so quick edits don't queue obsolete copies
      state.editSequence += 1;
      state.pending = true;
      clearTimeout(state.saveTimer);
      if (!state.busy && !state.paused) {
        state.saveTimer = setTimeout(() => void saveDraft(true), AUTOSAVE_DELAY_MS);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(state.saveTimer);
    };
  }, [store, saveDraft]);

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
      link.download = projectFilename(current.title);
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

  async function saveFile(saveAs = false) {
    if (local.current.busy || store.getSnapshot().project === null) return;
    if (!canPickProjectFiles()) {
      // Browsers without writable file handles still get a portable JSON download
      exportProject();
      return;
    }
    local.current.busy = true;
    clearTimeout(local.current.saveTimer);
    setStorageOperation("file");
    setError("");
    try {
      const current = store.getSnapshot().project;
      if (current === null) return;
      const encoded = serializeProject(current, assetKinds);
      if (!encoded.ok) {
        setError(encoded.error.message);
        return;
      }
      // Capture this scene before waiting for the picker
      // Any edits made while it is open go through the next queued save
      const previousHandle = local.current.file;
      // Picker must start from the click itself so the browser sees a user gesture
      const chosen = saveAs || previousHandle === null;
      const handle = chosen
        ? await pickProjectDestination(fileName || projectFilename(current.title))
        : previousHandle;
      if (handle === undefined || handle === null) return;
      if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
        local.current.filePaused = true;
        setFileFailed(true);
        setError("File permission was not granted; your current scene is still open");
        return;
      }
      // Save As keeps the old destination until the new file has actually committed
      const baseline = chosen ? await (await handle.getFile()).text() : local.current.fileText;
      await writeProjectFile(handle, encoded.value, baseline);
      local.current.file = handle;
      local.current.fileText = encoded.value;
      local.current.filePaused = false;
      setFileName(handle.name);
      local.current.fileSnapshot = current;
      setFileSavedProject(current);
      setFileFailed(false);
      setNotice(`Saved ${handle.name}`);
      await rememberProjectFile(current.projectId, handle, encoded.value).catch(() => {
        setNotice("File saved; choose Open next time to reconnect it");
      });
      // Save explicitly chose this scene, so align its recovery revision before the next write
      const previous = await loadLocalDraft(current.projectId, assetKinds);
      if (previous.ok) {
        local.current.revision = previous.value?.localStorageRevision ?? 0;
        local.current.editSequence = Math.max(
          local.current.editSequence,
          (previous.value?.localEditSequence ?? -1) + 1,
        );
        local.current.paused = false;
      }
      // Edits during the picker remain pending after the captured file snapshot
      local.current.pending = true;
    } catch (error) {
      if (!wasPickerCancelled(error)) {
        local.current.filePaused = true;
        setFileFailed(true);
        setError(
          error instanceof Error
            ? error.message
            : "File save failed; your current scene is still open",
        );
      }
    } finally {
      local.current.busy = false;
      setStorageOperation(null);
      if (local.current.pending && !local.current.paused) {
        local.current.saveTimer = setTimeout(() => void saveDraft(true), AUTOSAVE_DELAY_MS);
      }
    }
  }

  // Ctrl+S follows the same permission and destination rules as the menu
  useEffect(() => {
    function saveShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        document.getElementById(event.shiftKey ? "project-save-as" : "project-save")?.click();
      }
    }
    addEventListener("keydown", saveShortcut);
    return () => removeEventListener("keydown", saveShortcut);
  }, []);

  async function openProjectFile() {
    if (local.current.busy) return;
    if (!canPickProjectFiles()) {
      document.getElementById("project-import")?.click();
      return;
    }
    try {
      const handle = await pickProjectFile();
      if (handle !== undefined) {
        // Opening a writable project is an explicit gesture; denial still allows read-only opening
        await handle.requestPermission({ mode: "readwrite" });
        await importProject(await handle.getFile(), handle);
      }
    } catch (error) {
      if (!wasPickerCancelled(error))
        setError("Could not open the project file; your scene is unchanged");
    }
  }

  async function importProject(file: File, handle: ProjectFileHandle | null = null) {
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
      if (
        shouldWarnBeforeLeaving &&
        !(await askToReplace(
          "Open this project and replace changes that have not been saved to a file?",
          "Open",
        ))
      )
        return;
      if (store.getSnapshot() !== before) {
        setError("The scene changed while opening the file; try Open again");
        return;
      }
      const previous = await loadLocalDraft(checked.value.projectId, assetKinds);
      if (store.getSnapshot() !== before) return;
      const loaded = store.loadProject(text, assetKinds);
      if (!loaded.ok) {
        setError(loaded.error.message);
        return;
      }
      // Open makes this file the current project and seeds its browser backup revision
      // Loading also publishes an edit; replace that queued write with the opened snapshot
      clearTimeout(local.current.saveTimer);
      local.current.pending = false;
      local.current.paused = false;
      local.current.revision =
        previous.ok && previous.value !== null ? previous.value.localStorageRevision : 0;
      local.current.editSequence =
        previous.ok && previous.value !== null ? previous.value.localEditSequence + 1 : 0;
      local.current.file = handle;
      local.current.fileText = text;
      local.current.filePaused = false;
      setFileName(handle?.name ?? file.name);
      local.current.fileSnapshot = loaded.value;
      setFileSavedProject(loaded.value);
      setFileFailed(false);
      // Even an unchanged opened file gets a recovery copy before any later editing
      local.current.pending = true;
      await rememberProjectFile(loaded.value.projectId, handle, text).catch(() => undefined);
      clearTimeout(local.current.noticeTimer);
      setSavedProject(null);
      setSaveFailed(false);
      setSelectedId(null);
      setDragging(false);
      setNotice("Project opened");
    } catch {
      setError("Could not read the project file; your scene is unchanged");
    } finally {
      local.current.busy = false;
      setStorageOperation(null);
      if (local.current.pending && !local.current.paused) {
        local.current.saveTimer = setTimeout(() => void saveDraft(true), AUTOSAVE_DELAY_MS);
      }
    }
  }

  useEffect(() => {
    // Restore only into the untouched startup scene
    // Strict Mode can start this read twice; cleanup makes the earlier result harmless
    let cancelled = false;
    const before = store.getSnapshot();
    local.current.busy = true;
    async function reopenLastProject() {
      try {
        // A development refresh must leave an already-open project alone
        if (before.project !== null || before.objects.length > 0) return;
        const result = await loadLatestLocalDraft(assetKinds);
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        if (result.value === null) return;
        // Someone may have placed an object while the storage read was pending
        if (store.getSnapshot() !== before) {
          setNotice("Saved work was kept in this browser; refresh to reopen it");
          return;
        }
        const restored = store.loadProject(JSON.stringify(result.value.document), assetKinds);
        if (!restored.ok) {
          setError(restored.error.message);
          return;
        }
        // Loading publishes a store update but doesn't need another storage write
        clearTimeout(local.current.saveTimer);
        local.current.pending = false;
        local.current.paused = false;
        local.current.revision = result.value.localStorageRevision;
        local.current.editSequence = result.value.localEditSequence;
        setSavedProject(restored.value);
        setSaveFailed(false);
        setSelectedId(null);
        setDragging(false);
        setNotice("Reopened your last project");
        try {
          const link = await recallProjectFile(restored.value.projectId);
          if (cancelled) return;
          if (link === null) {
            // An empty browser-only project can reopen without gaining a leave warning
            if (restored.value.scenes[0]?.objects.length === 0) setEmptyProject(restored.value);
            return;
          }
          // Keep the recovered scene editable without reviving a browser file capability
          // Save reconnects through the picker with the previous filename suggested
          setFileName(link.name);
          local.current.filePaused = true;
          setNotice("Project reopened; choose Save to reconnect its file");
        } catch {
          // Losing a file connection must never stop browser recovery from opening the scene
          local.current.filePaused = true;
          setNotice("Project reopened; use Save As to choose its file");
        }
      } catch {
        if (!cancelled) setError("Could not reopen saved work; the browser copy was kept");
      } finally {
        if (!cancelled) {
          local.current.busy = false;
          setStorageOperation(null);
          if (local.current.pending && !local.current.paused) {
            local.current.saveTimer = setTimeout(() => void saveDraft(true), AUTOSAVE_DELAY_MS);
          }
        }
      }
    }
    void reopenLastProject();
    return () => {
      cancelled = true;
    };
  }, [store, saveDraft]);

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

  async function openSampleProject() {
    if (local.current.busy) return;
    if (
      hasChanges &&
      !isUntouchedProject &&
      !(await askToReplace("Replace the current scene with the sample project?"))
    ) {
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
    // Choosing Save gives this sample a file destination before browser writes resume
    clearTimeout(local.current.saveTimer);
    local.current.pending = false;
    local.current.paused = false;
    local.current.revision = 0;
    local.current.editSequence = 0;
    setSavedProject(null);
    local.current.file = null;
    local.current.fileText = "";
    local.current.fileSnapshot = null;
    local.current.filePaused = false;
    setFileName("");
    setFileSavedProject(null);
    setFileFailed(false);
    setSaveFailed(false);
    setSelectedId(null);
    setDragging(false);
    setError("");
    setNotice("Opened sample project");
  }

  useEffect(() => {
    if (!shouldWarnBeforeLeaving) {
      return;
    }
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      // Browser owns this warning; a recovery backup does not mean the JSON file is current
      event.preventDefault();
      // Some browser hosts still check returnValue before showing the leave prompt
      event.returnValue = "Unsaved project changes";
    }
    addEventListener("beforeunload", warnBeforeLeaving);
    // Remove the warning when the current snapshot has been saved
    return () => removeEventListener("beforeunload", warnBeforeLeaving);
  }, [shouldWarnBeforeLeaving]);

  function place(assetId: string, position: Vector3Tuple) {
    // Choosing the first room turns the grid scene into a saveable project
    // Room placement uses the environment slot so it survives JSON reconstruction
    if (store.getSnapshot().project === null && assetKinds.get(assetId) === "environment") {
      if (local.current.busy) {
        setNotice("Wait for the project to finish opening, then choose a room");
        return;
      }
      const created = store.createProject(assetId);
      if (!created.ok) {
        setError(created.error.message);
        return;
      }
      setError("");
      setDragging(false);
      if (created.value.scenes[0]?.objects.length === 0) setEmptyProject(created.value);
      setNotice("Project created; choose Save to name its file");
      return;
    }
    const result = store.addObject(assetId, position);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError("");
    setSelectedId(result.object.id);
    const addedNotice = `Added ${result.object.name}`;
    setNotice(addedNotice);
    // CSS fades this notice during the last half second of its three-second lifetime
    // A newer placement restarts the timer; save and recovery feedback keep their own text
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
              title="Open a JSON project file"
              disabled={status !== "ready" || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void openProjectFile();
              }}
            >
              Open
            </button>
            <button
              id="project-save"
              type="button"
              title={
                project === null
                  ? "Choose a room to create your project"
                  : "Save changes to the current file · Ctrl+S"
              }
              disabled={project === null || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void saveFile();
              }}
            >
              Save
            </button>
            <button
              id="project-save-as"
              type="button"
              title={
                project === null
                  ? "Choose a room to create your project"
                  : "Choose a filename and folder · Ctrl+Shift+S"
              }
              disabled={project === null || storageOperation !== null}
              onClick={() => {
                closeDraftMenu();
                void saveFile(true);
              }}
            >
              Save As
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
        {/* Saving stays visible until the write finishes; backup-only work keeps its own label */}
        {hasChanges && (
          <span
            className="save-state"
            data-state={
              storageOperation === "save" || storageOperation === "file"
                ? "saving"
                : fileFailed || saveFailed
                  ? "failed"
                  : !hasUnsavedChanges
                    ? "saved"
                    : browserHasChanges
                      ? "pending"
                      : "backup"
            }
            title={
              fileName
                ? `Current file: ${fileName}${hasUnsavedChanges ? " · file changes are pending" : ""}`
                : "Choose Save to name your project file; browser recovery runs in the background"
            }
            role="status"
          >
            {storageOperation === "save" || storageOperation === "file"
              ? "Saving…"
              : fileFailed || saveFailed
                ? "Save failed"
                : !hasUnsavedChanges
                  ? "Saved"
                  : browserHasChanges
                    ? "Unsaved changes"
                    : "Saved in browser"}
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
      <p
        key={notice}
        className={`draft-feedback${notice.startsWith("Added ") && storageOperation !== "import" && storageOperation !== "recover" ? " is-placement" : ""}`}
        role="status"
      >
        {storageOperation === "recover"
          ? "Reopening saved work…"
          : storageOperation === "import"
            ? "Reading project file…"
            : notice}
      </p>
      {confirmation !== null && (
        <ProjectConfirmation
          message={confirmation.message}
          action={confirmation.action}
          onChoice={answerConfirmation}
        />
      )}
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
