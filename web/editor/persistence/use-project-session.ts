import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueAsset } from "../../shared/assets/catalogue";
import type { ProjectDocument } from "../../shared/project/project-types";
import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { MAX_PROJECT_BYTES } from "../../shared/project/project-limits";
import { createDocumentStore } from "../document-store";
import type { RecoveryHistory } from "../recovery-history";
import {
  loadLatestLocalDraft,
  loadRecoverySession,
  saveRecoverySession,
  type RecoverySession,
} from "./local-drafts";
import {
  canPickProjectFiles,
  pickProjectFile,
  pickProjectDestination,
  projectFilename,
  wasPickerCancelled,
  writeProjectFile,
  recallProjectFile,
  type ProjectFileHandle,
} from "./project-files";

export type ProjectDecision = "save" | "discard" | "cancel";
type Operation = "recover" | "import" | "file" | "switch" | "backup" | null;
type Candidate = {
  document: ProjectDocument;
  fileName: string;
  savedJson: string | null;
  fileText: string;
  handle: ProjectFileHandle | null;
  pristine: boolean;
};
const RECOVERY_DELAY_MS = 2_000;

export function useProjectSession(
  store: ReturnType<typeof createDocumentStore>,
  assets: readonly CatalogueAsset[],
  project: ProjectDocument | null,
  objectCount: number,
  onReplace: () => void,
  onNotice: (message: string) => void,
) {
  const kinds = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.kind])), [assets]);
  const [operation, setOperation] = useState<Operation>("recover");
  const [fileName, setFileName] = useState("");
  const [savedJson, setSavedJson] = useState<string | null>(null);
  const [pristineProject, setPristineProject] = useState<ProjectDocument | null>(null);
  const [fileFailed, setFileFailed] = useState(false);
  const [error, setError] = useState("");
  const setNotice = onNotice;
  const [confirmation, setConfirmation] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const decision = useRef<((choice: ProjectDecision) => void) | null>(null);
  // Keep file access and pending writes together for the current editing session
  // React state below only drives what the student sees
  const state = useRef({
    // Another tab may have saved more recent work under the same browser account
    revision: 0,
    busy: true,
    switching: false,
    pending: false,
    paused: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    file: null as ProjectFileHandle | null,
    // Exact bytes last opened or written; used to catch changes made outside this editor
    fileText: "",
    fileName: "",
    savedJson: null as string | null,
    pristine: null as ProjectDocument | null,
    recovered: null as ProjectDocument | null,
    previousProjectId: undefined as string | undefined,
  });
  // Compare authored values so undoing back to the saved layout clears the dirty status
  const currentJson = useMemo(() => {
    if (project === null) return null;
    const encoded = serializeProject(project, kinds);
    return encoded.ok ? encoded.value : null;
  }, [project, kinds]);
  const dirty = project === null ? objectCount > 0 : currentJson !== savedJson;
  // An untouched room has nothing to lose when starting over
  // The first object edit replaces this snapshot and enables the save question
  const needsDecision = dirty && (project === null || project !== pristineProject);

  const persist = useCallback(
    async (
      document: ProjectDocument,
      metadata?: Candidate,
      history: RecoveryHistory | undefined = metadata ? undefined : store.getRecoveryHistory(),
    ) => {
      const local = state.current;
      const result = await saveRecoverySession(
        {
          document,
          fileName: metadata?.fileName ?? local.fileName,
          savedJson: metadata ? metadata.savedJson : local.savedJson,
          pristine: metadata?.pristine ?? document === local.pristine,
          fileHandle: metadata ? metadata.handle : local.file,
          fileText: metadata ? metadata.fileText : local.fileText,
          // Capture history with the scene before IndexedDB yields to later edits
          ...(history ? { history } : {}),
        },
        local.revision,
        kinds,
        local.previousProjectId,
      );
      if (!result.ok) {
        // Stop retrying a stale session over and over while the student is editing
        // Manual Save can still preserve the project in its JSON file
        local.paused = true;
        setError(result.error.message);
        return false;
      }
      local.revision = result.value;
      local.previousProjectId = document.projectId;
      local.recovered = document;
      local.paused = false;
      return true;
    },
    [kinds, store],
  );

  const backup = useCallback(
    async function backup() {
      const local = state.current;
      const current = store.getSnapshot().project;
      if (current === null || local.busy || local.switching || local.paused) return;
      local.busy = true;
      setOperation("backup");
      local.pending = false;
      // Recovery only writes IndexedDB; file status belongs to explicit Save
      try {
        await persist(current);
      } finally {
        local.busy = false;
        setOperation(null);
        if (local.pending && !local.paused)
          local.timer = setTimeout(() => void backup(), RECOVERY_DELAY_MS);
      }
    },
    [store, persist],
  );

  useEffect(() => {
    const local = state.current;
    const unsubscribe = store.subscribe(() => {
      // Each completed edit restarts the delay so a burst of changes gets one backup
      local.pending = true;
      clearTimeout(local.timer);
      if (!local.busy && !local.switching && !local.paused)
        local.timer = setTimeout(() => void backup(), RECOVERY_DELAY_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(local.timer);
      decision.current?.("cancel");
      decision.current = null;
    };
  }, [store, backup]);

  useEffect(() => {
    let cancelled = false;
    const before = store.getSnapshot();
    const local = state.current;
    local.busy = true;
    async function restore() {
      try {
        if (before.project !== null || before.objects.length > 0) return;
        const result = await loadRecoverySession(kinds);
        if (!result.ok) {
          if (!cancelled) setError(result.error.message);
          return;
        }
        let recovered: RecoverySession | null = result.value;
        if (recovered === null) {
          // Carry forward an older installation's last draft without losing unfinished work
          const legacy = await loadLatestLocalDraft(kinds);
          if (!legacy.ok) {
            if (!cancelled) setError(legacy.error.message);
            return;
          }
          if (legacy.value !== null) {
            if (cancelled) return;
            if (
              legacy.value.recoveryWarning &&
              !window.confirm(
                `${legacy.value.recoveryWarning}\nOpen the newest readable backup, "${legacy.value.document.title}"?`,
              )
            ) {
              setError(legacy.value.recoveryWarning);
              return;
            }
            const link = await recallProjectFile(legacy.value.projectId).catch(() => null);
            let baseline: string | null = null;
            if (link) {
              const checked = deserializeProject(link.text, kinds);
              if (checked.ok && checked.value.projectId === legacy.value.document.projectId)
                baseline = JSON.stringify(checked.value);
            }
            recovered = {
              revision: 0,
              document: legacy.value.document,
              fileName: link?.name ?? "",
              savedJson: baseline,
              pristine: !link && legacy.value.document.scenes[0]?.objects.length === 0,
              ...(legacy.value.history ? { history: legacy.value.history } : {}),
              ...(legacy.value.historyWarning
                ? { historyWarning: legacy.value.historyWarning }
                : {}),
            };
          }
        }
        // Storage can finish after the student has already started another project
        // Leave that newer scene alone
        if (cancelled || recovered === null || store.getSnapshot() !== before) return;
        const loaded = store.loadProject(
          JSON.stringify(recovered.document),
          kinds,
          recovered.history,
        );
        if (!loaded.ok) {
          setError(loaded.error.message);
          return;
        }
        local.revision = recovered.revision;
        local.fileName = recovered.fileName;
        local.savedJson = recovered.savedJson;
        local.file = recovered.fileHandle ?? null;
        local.fileText = recovered.fileText ?? recovered.savedJson ?? "";
        local.pristine = recovered.pristine ? loaded.value : null;
        local.recovered = loaded.value;
        local.previousProjectId = loaded.value.projectId;
        // The baseline restores Saved or Not saved independently of the browser backup
        // Restoring the handle stays quiet; permission is requested when Save is clicked
        setFileName(recovered.fileName);
        setSavedJson(recovered.savedJson);
        setPristineProject(local.pristine);
        setNotice("Reopened your last project");
        if (recovered.historyWarning) setError(recovered.historyWarning);
        clearTimeout(local.timer);
        local.pending = recovered.revision === 0;
      } catch {
        if (!cancelled) setError("Could not reopen your project; the stored copy was kept");
      } finally {
        if (!cancelled) {
          local.busy = false;
          setOperation(null);
          if (local.pending) local.timer = setTimeout(() => void backup(), RECOVERY_DELAY_MS);
        }
      }
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, [store, kinds, backup, setNotice]);

  async function save(saveAs = false, duringSwitch = false): Promise<boolean> {
    const local = state.current;
    const current = store.getSnapshot().project;
    if (local.busy || (local.switching && !duringSwitch)) return false;
    if (current === null) {
      setError("Choose a room before saving this project");
      return false;
    }
    const encoded = serializeProject(current, kinds);
    if (!encoded.ok) {
      setError(encoded.error.message);
      return false;
    }
    // A file picker can stay open while edits arrive; keep history tied to this saved snapshot
    const recoveryHistory = store.getRecoveryHistory();
    local.busy = true;
    clearTimeout(local.timer);
    setOperation("file");
    setError("");
    try {
      if (!canPickProjectFiles()) {
        const url = URL.createObjectURL(new Blob([encoded.value], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = projectFilename(current.title);
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        // A download has no completion receipt; don't discard work on that assumption
        setNotice("Project download started; verify the downloaded file before discarding changes");
        // Retry the browser backup independently of writable file support
        // A conflicting tab still fails the same revision check
        await persist(current, undefined, recoveryHistory);
        return false;
      }
      const chosen = saveAs || local.file === null;
      // Ordinary Save reuses the file selected during Open
      // New projects and Save As need a destination first
      const handle = chosen
        ? await pickProjectDestination(local.fileName || projectFilename(current.title))
        : local.file;
      if (!handle) return false;
      // Reuse permission already granted for this file
      // Chrome owns the permission popup when access still needs approval
      if (
        (await handle.queryPermission({ mode: "readwrite" })) !== "granted" &&
        (await handle.requestPermission({ mode: "readwrite" })) !== "granted"
      ) {
        setFileFailed(true);
        setError("Couldn’t save without file access; your changes are still here");
        return false;
      }
      // Selecting a destination explicitly allows replacing that selected file
      // Existing connected files still need to match the text last read or written
      const baseline = chosen ? await (await handle.getFile()).text() : local.fileText;
      await writeProjectFile(handle, encoded.value, baseline);
      // Only mark this version as saved after the file stream has closed successfully
      // Any edits made during the write still differ from this captured version
      local.file = handle;
      local.fileName = handle.name;
      local.fileText = encoded.value;
      local.savedJson = encoded.value;
      setFileName(handle.name);
      setSavedJson(encoded.value);
      setFileFailed(false);
      setNotice(`Saved ${handle.name}`);
      // Store the manual-save baseline alongside this snapshot for the next visit
      await persist(current, undefined, recoveryHistory);
      return true;
    } catch (failure) {
      if (!wasPickerCancelled(failure)) {
        setFileFailed(true);
        setError(
          failure instanceof Error ? failure.message : "Save failed; your project is still open",
        );
      }
      return false;
    } finally {
      local.busy = false;
      setOperation(duringSwitch ? "switch" : null);
      if (local.pending && !local.paused && !local.switching)
        local.timer = setTimeout(() => void backup(), RECOVERY_DELAY_MS);
    }
  }

  function answer(choice: ProjectDecision) {
    setDeciding(choice !== "cancel");
    decision.current?.(choice);
    decision.current = null;
  }

  async function switchTo(candidate: Candidate) {
    const local = state.current;
    if (local.busy || local.switching) return;
    local.switching = true;
    clearTimeout(local.timer);
    setOperation("switch");
    setError("");
    const before = store.getSnapshot();
    try {
      if (needsDecision) {
        setConfirmation(true);
        setDeciding(false);
        const choice = await new Promise<ProjectDecision>((resolve) => {
          decision.current = resolve;
        });
        if (choice === "cancel") return;
        // Don't Save falls through to replacing the session below
        // The original JSON stays exactly as it was on disk
        // Save runs from the dialog click so the native picker can use that user gesture
        if (choice === "save" && !(await save(false, true))) return;
      }
      if (store.getSnapshot() !== before) {
        setError("The scene changed while switching; try again");
        return;
      }
      local.busy = true;
      // Commit the next recovery record before replacing the visible scene
      // A storage failure must leave the current project available to save
      if (!(await persist(candidate.document, candidate))) return;
      const loaded = store.loadProject(JSON.stringify(candidate.document), kinds);
      if (!loaded.ok) {
        setError(loaded.error.message);
        return;
      }
      local.file = candidate.handle;
      local.fileText = candidate.fileText;
      local.fileName = candidate.fileName;
      local.savedJson = candidate.savedJson;
      local.pristine = candidate.pristine ? loaded.value : null;
      local.recovered = loaded.value;
      local.pending = false;
      setFileName(candidate.fileName);
      setSavedJson(candidate.savedJson);
      setPristineProject(local.pristine);
      setFileFailed(false);
      onReplace();
      setNotice(candidate.pristine ? "New project" : "Project opened");
    } finally {
      local.busy = false;
      local.switching = false;
      setConfirmation(false);
      setDeciding(false);
      setOperation(null);
      if (local.pending && !local.paused)
        local.timer = setTimeout(() => void backup(), RECOVERY_DELAY_MS);
    }
  }

  async function importFile(file: File, handle: ProjectFileHandle | null = null) {
    const local = state.current;
    if (local.busy || local.switching) return;
    if (file.size > MAX_PROJECT_BYTES) {
      setError("Project JSON exceeds the 5 MiB file limit");
      return;
    }
    const before = store.getSnapshot();
    local.busy = true;
    setOperation("import");
    setError("");
    let candidate: Candidate | null = null;
    try {
      const text = await file.text();
      const checked = deserializeProject(text, kinds);
      // Reject a broken file before asking the student to leave their current work
      if (!checked.ok) {
        setError(checked.error.message);
        return;
      }
      if (store.getSnapshot() !== before) {
        setError("The scene changed while reading the file; try Open again");
        return;
      }
      candidate = {
        document: checked.value,
        fileName: file.name,
        savedJson: JSON.stringify(checked.value),
        fileText: text,
        handle,
        pristine: false,
      };
    } catch {
      setError("Could not open the project; your scene is unchanged");
    } finally {
      local.busy = false;
      setOperation(null);
      if (!candidate && local.pending && !local.paused)
        local.timer = setTimeout(() => void backup(), RECOVERY_DELAY_MS);
    }
    if (candidate) await switchTo(candidate);
  }

  async function open() {
    if (state.current.busy || state.current.switching) return;
    if (!canPickProjectFiles()) {
      document.getElementById("project-import")?.click();
      return;
    }
    try {
      const handle = await pickProjectFile();
      // Reading a project never requests permission to overwrite it
      if (handle) await importFile(await handle.getFile(), handle);
    } catch (failure) {
      if (!wasPickerCancelled(failure))
        setError("Could not open the project; your scene is unchanged");
    }
  }

  async function createNew() {
    const environmentId =
      store.getSnapshot().project?.scenes[0]?.environmentAssetId ??
      assets.find((asset) => asset.kind === "environment")?.id;
    if (!environmentId) {
      setError("No room is available in the asset library");
      return;
    }
    // Build and validate separately so Cancel never changes the live document
    const result = createDocumentStore(assets).createProject(environmentId);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await switchTo({
      document: result.value,
      fileName: "",
      savedJson: null,
      fileText: "",
      handle: null,
      pristine: true,
    });
  }

  async function openSample(document: unknown) {
    const result = deserializeProject(JSON.stringify(document), kinds);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await switchTo({
      document: result.value,
      fileName: "",
      savedJson: null,
      fileText: "",
      handle: null,
      pristine: false,
    });
  }

  function markPristine(document: ProjectDocument) {
    state.current.pristine = document;
    setPristineProject(document);
  }

  useEffect(() => {
    if (!needsDecision) return;
    // Chrome supplies the wording for closing or refreshing an unsaved tab
    // Our own three-button prompt handles Open and New inside the editor
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "Unsaved project changes";
    }
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [needsDecision]);

  return {
    operation,
    fileName,
    dirty,
    fileFailed,
    error,
    confirmation,
    deciding,
    answer,
    save,
    open,
    importFile,
    createNew,
    openSample,
    markPristine,
    busy: operation !== null,
    clearError: () => setError(""),
  };
}
