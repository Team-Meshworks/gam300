import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { assets } from "virtual:asset-catalogue";
import { App } from "./App";
import { HOTSPOT_ASSET } from "../shared/asset-runtime/hotspot";
import { createDocumentStore } from "./document-store";
import { createAccountClient, type AccountRole } from "./accounts/account-client";
import { LoginRedirect } from "./accounts/LoginRedirect";
import {
  readServerAssets,
  readServerProject,
  type OpenedServerProject,
} from "./persistence/server-project-read";
import { connectServerProjectSession } from "./persistence/server-project-session";
import { loadRecoverySession, type RecoverySession } from "./persistence/local-drafts";
import {
  pickProjectDestination,
  projectFilename,
  wasPickerCancelled,
  writeProjectFile,
} from "./persistence/project-files";
import { serializeProject } from "../shared/project/project-serialization";
import { deserializeProject } from "../shared/project/project-deserialization";
import { MAX_PROJECT_BYTES } from "../shared/project/project-limits";
import { createWorkspaceClient, isId, isRecord, projectReceipt } from "./home/workspace-api";
import { Icon } from "./ui/Icon";
import type { ServerSaveStatus } from "./persistence/server-autosave";
import { parseProgressContext, reviewReturnUrl } from "./projects/progress-navigation";

const accounts = createAccountClient();
const workspace = createWorkspaceClient();
type Candidate = {
  opened: OpenedServerProject;
  recovery: RecoverySession | null;
  controller: AbortController;
};
type Active = {
  session: ReturnType<typeof connectServerProjectSession>;
  accountId: string;
  orgId: string | null;
  role: AccountRole;
  controller: AbortController;
  title: string;
};
const labels: Record<ServerSaveStatus, string> = {
  saved: "Saved to server",
  unsaved: "Unsaved changes",
  saving: "Saving to server...",
  failed: "Save failed. Your edits are still here. Retry or export a copy.",
  conflict:
    "Another revision was saved. Export your edits or open the server version; nothing will be overwritten automatically.",
  rejected:
    "Saving is unavailable for this account or project. Keep a recovery copy or export your edits before leaving.",
};

function ChoiceDialog({
  title,
  children,
  cancel,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  cancel: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector<HTMLButtonElement>("[data-initial-focus]")?.focus();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-confirmation"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          cancel();
        }
      }}
    >
      <button
        className="project-confirmation-close"
        type="button"
        aria-label="Close dialog"
        disabled={busy}
        onClick={cancel}
      >
        <Icon name="close" />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

// SCRUM-126 can open /?projectId=<id>; this boundary owns only the editor's save/recovery session.
export function ServerProjectEditor({ projectId }: { projectId: string }) {
  const [signedOut, setSignedOut] = useState(false);
  const [catalogue, setCatalogue] = useState<{
    all: readonly CatalogueAsset[];
    available: readonly CatalogueAsset[];
    unavailable: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setError("");
        const identity = await accounts.getSession();
        if (controller.signal.aborted) return;
        if (!identity) {
          setSignedOut(true);
          return;
        }
        if (identity.mustChangePassword) throw new Error("Sign in before opening this project.");
        let approved: readonly CatalogueAsset[];
        let retained: readonly CatalogueAsset[];
        let unavailable = false;
        try {
          [approved, retained] = await Promise.all([
            readServerAssets(identity.userId, controller.signal),
            readServerAssets(identity.userId, controller.signal, fetch, projectId),
          ]);
        } catch (cause) {
          // Only open without a catalogue when the saved document needs no assets
          const empty = await readServerProject(
            projectId,
            identity.userId,
            new Map(),
            controller.signal,
          );
          if (!empty.ok || controller.signal.aborted) throw cause;
          approved = [];
          retained = [];
          unavailable = true;
        }
        const current = await accounts.getSession();
        if (controller.signal.aborted) return;
        if (!current) {
          setSignedOut(true);
          return;
        }
        if (
          current.userId !== identity.userId ||
          current.orgId !== identity.orgId ||
          current.role !== identity.role ||
          current.mustChangePassword ||
          current.developmentAssetsAllowed !== identity.developmentAssetsAllowed
        )
          throw new Error("The account changed. Sign in again.");
        const developmentAssets = current.developmentAssetsAllowed === true ? assets : [];
        if (!controller.signal.aborted)
          setCatalogue({
            all: [
              ...new Map(
                [...developmentAssets, ...approved, ...retained].map((asset) => [asset.id, asset]),
              ).values(),
            ],
            available: [...developmentAssets, ...approved],
            unavailable,
          });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Approved assets could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [attempt, projectId]);
  if (signedOut) return <LoginRedirect />;
  if (!catalogue)
    return (
      <main>
        <h1>Open project</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => setAttempt((value) => value + 1)}>Retry opening</button>{" "}
            <a href="/home">Home</a>
          </>
        ) : (
          <p role="status">Loading approved assets…</p>
        )}
      </main>
    );
  return (
    <>
      {catalogue.unavailable && (
        <p role="status">
          Some 3D assets are unavailable. Save and reopen the project when the asset service
          returns.
        </p>
      )}
      <ServerProjectSession
        projectId={projectId}
        catalogue={catalogue.all}
        available={catalogue.available}
      />
    </>
  );
}

function ServerProjectSession({
  projectId,
  catalogue,
  available,
}: {
  projectId: string;
  catalogue: readonly CatalogueAsset[];
  available: readonly CatalogueAsset[];
}) {
  const editorAssets = useMemo(() => [...catalogue, HOTSPOT_ASSET], [catalogue]);
  const kinds = useMemo(
    () => new Map(editorAssets.map((asset) => [asset.id, asset.kind])),
    [editorAssets],
  );
  const [store] = useState(() => createDocumentStore(editorAssets));
  const [active, setActive] = useState<Active | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const current = useRef<Active | null>(null);
  const retained = useRef<{ accountId: string; recovery: RecoverySession } | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [status, setStatus] = useState<ServerSaveStatus>("saved");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [departure, setDeparture] = useState<"home" | "logout" | "reload" | "publish" | null>(null);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (retained.current) {
        event.preventDefault();
        event.returnValue = "Unsaved draft retained in this tab";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  async function install(next: Candidate, recover: boolean) {
    const { opened, controller } = next;
    const identity = await accounts.getSession();
    if (controller.signal.aborted) return;
    if (!identity || identity.mustChangePassword || identity.userId !== opened.accountId)
      throw new Error(
        "The account changed. Sign in with the original account and reopen this project.",
      );
    const recovery = recover ? next.recovery : null;
    const document = recovery?.document ?? opened.document;
    const options = { allowDraftLinks: !!recovery };
    const encoded = serializeProject(document, kinds, options);
    if (!encoded.ok) throw new Error(encoded.error.message);
    const loaded = store.loadProject(encoded.value, kinds, recovery?.history, options);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const session = connectServerProjectSession({
      accountId: opened.accountId,
      store,
      assetKinds: kinds,
      revision: recovery?.serverSave?.revision ?? opened.revision,
      storageRevision: next.recovery?.revision ?? 0,
      signal: controller.signal,
      onStatus: setStatus,
      ...(recovery ? { recovery } : {}),
    });
    const owner = {
      session,
      accountId: opened.accountId,
      orgId: identity.orgId,
      role: identity.role,
      controller,
      title: document.title,
    };
    current.current = owner;
    setActive(owner);
    setCandidate(null);
    retained.current = null;
    setError(recovery?.historyWarning ?? "");
  }

  useEffect(() => {
    const controller = new AbortController();
    let owner: Active | null = null;
    async function open() {
      setLoading(true);
      setError("");
      try {
        const identity = await accounts.getSession();
        if (controller.signal.aborted) return;
        if (!identity && !retained.current) {
          setSignedOut(true);
          return;
        }
        if (!identity || identity.mustChangePassword)
          throw new Error("Sign in before opening this project.");
        if (retained.current && identity.userId !== retained.current.accountId)
          throw new Error(
            "Sign in with the original account to recover the draft still held in this tab.",
          );
        const result = await readServerProject(
          projectId,
          identity.userId,
          kinds,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value.canEdit)
          throw new Error("This project is read-only. Your stored recovery copy was kept.");
        if (retained.current) {
          await install(
            { opened: result.value, recovery: retained.current.recovery, controller },
            true,
          );
          owner = current.current;
          return;
        }
        const recovery = await loadRecoverySession(kinds, {
          accountId: identity.userId,
          projectId,
        });
        if (controller.signal.aborted) return;
        if (!recovery.ok) throw new Error(recovery.error.message);
        const next = { opened: result.value, recovery: recovery.value, controller };
        if (recovery.value) setCandidate(next);
        else {
          await install(next, false);
          owner = current.current;
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Project could not be opened.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void open();
    return () => {
      controller.abort();
      // Includes a recovery choice made after open() finished.
      const closing = current.current?.controller === controller ? current.current : owner;
      if (closing) void closing.session.dispose();
    };
    // A fresh attempt owns its own cancellation boundary; install uses only that candidate and the stable store.
    // eslint-disable-next-line react-hooks-js/exhaustive-deps
  }, [projectId, attempt, store]);

  async function checkDraftAccount(owner: Active) {
    const identity = await accounts.getSession();
    if (owner.controller.signal.aborted) return null;
    if (
      identity?.userId === owner.accountId &&
      identity.orgId === owner.orgId &&
      identity.role === owner.role &&
      !identity.mustChangePassword
    )
      return identity;

    // Lock the live draft before awaiting account-scoped recovery storage
    retained.current = { accountId: owner.accountId, recovery: owner.session.getRecovery() };
    owner.controller.abort();
    current.current = null;
    setActive(null);
    setDeparture(null);
    setLoading(true);
    const preserved = await owner.session.dispose();
    retained.current = preserved?.ok
      ? null
      : { accountId: owner.accountId, recovery: owner.session.getRecovery() };
    setLoading(false);
    if (!identity && preserved?.ok) setSignedOut(true);
    setError(
      preserved?.ok
        ? "Your account changed or expired. Sign in with the original account to reopen your retained draft."
        : "Your account changed or expired and recovery storage failed. Your draft is held only in this tab. Keep it open, sign in with the original account, then retry.",
    );
    return null;
  }

  useEffect(() => {
    if (!active) return;
    const owner = active;
    let checking = false;
    async function checkAccount() {
      if (checking || owner.controller.signal.aborted) return;
      checking = true;
      try {
        await checkDraftAccount(owner);
      } catch {
        // Offline editing retains the captured account; server writes also enforce that identity.
      } finally {
        checking = false;
      }
    }
    const warn = (event: BeforeUnloadEvent) => {
      if (owner.session.getStatus() !== "saved") {
        event.preventDefault();
        event.returnValue = "Unsaved changes";
      }
    };
    const hide = () => {
      owner.controller.abort();
      void owner.session.dispose();
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("focus", checkAccount);
    window.addEventListener("online", checkAccount);
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    const timer = setInterval(() => void checkAccount(), 15_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", checkAccount);
      window.removeEventListener("online", checkAccount);
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [active]);

  async function exportJson(json: string): Promise<boolean> {
    const title = store.getSnapshot().project?.title ?? "project";
    if (!("showSaveFilePicker" in window) || typeof window.showSaveFilePicker !== "function") {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = projectFilename(title);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setError(
        "Project download started. Verify the file; downloading does not confirm it was saved, so this tab stays open.",
      );
      return false;
    }
    const handle = await pickProjectDestination(projectFilename(title));
    if (!handle)
      throw new Error(
        "No file was saved. Choose a destination in a browser that supports saving files.",
      );
    await writeProjectFile(handle, json, await (await handle.getFile()).text());
    return true;
  }

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (!wasPickerCancelled(cause)) {
        setError(
          cause instanceof Error ? cause.message : "The operation failed. Your draft was kept.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function save(exportFile = false): Promise<boolean> {
    let saved = false;
    await run(async () => {
      if (!active || active.controller.signal.aborted) return;
      if (exportFile) {
        const document = store.getSnapshot().project;
        if (!document) return;
        const encoded = serializeProject(document, kinds);
        if (!encoded.ok) throw new Error(encoded.error.message);
        saved = await exportJson(encoded.value);
      } else {
        await active.session.flush();
        saved = active.session.getStatus() === "saved";
      }
    });
    return saved;
  }

  async function importFile(file: File) {
    await run(async () => {
      if (!active || active.controller.signal.aborted) {
        return;
      }
      if (file.size > MAX_PROJECT_BYTES) {
        throw new Error("Project JSON exceeds the 5 MiB file limit");
      }
      const imported = deserializeProject(await file.text(), kinds);
      if (!imported.ok) {
        throw new Error(imported.error.message);
      }
      const key = `spatia:uncertain-project-creation:${active.accountId}`;
      if (sessionStorage.getItem(key) === "1") {
        throw new Error(
          "Check All Projects before importing again; an earlier creation may have completed",
        );
      }
      // Keep this draft safe and import into a new project instead of overwriting it
      await active.session.flush();
      if (active.session.getStatus() !== "saved") {
        throw new Error("Save this project before importing another file");
      }
      const identity = await checkDraftAccount(active);
      if (!identity) {
        return;
      }
      const projectAccess = identity.orgId
        ? null
        : await workspace.read(`/api/v1/projects/${projectId}/assignments`);
      const organizationId =
        identity.orgId ??
        (isRecord(projectAccess) && isId(projectAccess.organizationId)
          ? projectAccess.organizationId
          : null);
      if (!organizationId) {
        throw new Error("The project organisation could not be verified; your draft is unchanged");
      }
      sessionStorage.setItem(key, "1");
      if (sessionStorage.getItem(key) !== "1") {
        throw new Error("Browser storage is unavailable; import was not sent");
      }
      const result = await workspace.write(active.accountId, "/api/v1/projects", "POST", {
        title: imported.value.title,
        document: imported.value,
        orgId: organizationId,
      });
      if (result.kind === "rejected") {
        sessionStorage.removeItem(key);
        throw new Error(result.message);
      }
      // A lost receipt may already have created the project; keep the existing creation guard
      if (result.kind !== "confirmed" || !projectReceipt(result.value) || !isRecord(result.value)) {
        throw new Error("Import could not be confirmed; check All Projects before trying again");
      }
      sessionStorage.removeItem(key);
      const preserved = await active.session.prepareToLeave("save");
      if (!preserved.ok || !preserved.value) {
        throw new Error(
          "The imported project is in All Projects; keep this draft open until its save completes",
        );
      }
      location.assign(`/?projectId=${encodeURIComponent(String(result.value.projectId))}`);
    });
  }

  async function leave(choice: "save" | "recovery" | "export" | "cancel") {
    if (choice === "cancel") {
      setDeparture(null);
      return;
    }
    await run(async () => {
      if (!active || !departure) return;
      const result = await active.session.prepareToLeave(choice, exportJson);
      if (!result.ok) throw new Error(result.error.message);
      if (!result.value) return;
      active.controller.abort();
      await active.session.dispose();
      current.current = null;
      setActive(null);
      setDeparture(null);
      if (departure === "reload") {
        setAttempt((value) => value + 1);
        return;
      }
      if (departure === "logout") {
        // Recheck before changing cookies so a different account is never signed out here.
        const identity = await accounts.getSession();
        if (identity?.userId === active.accountId) await accounts.signOut(active.accountId);
      }
      location.assign(
        departure === "logout"
          ? "/login"
          : departure === "publish"
            ? `/publish?projectId=${encodeURIComponent(projectId)}`
            : reviewReturnUrl(new URLSearchParams(location.search)),
      );
    });
  }

  if (signedOut) return <LoginRedirect />;
  return (
    <div className="server-editor-shell">
      {active ? (
        <App
          server={{
            assets: catalogue,
            selectionAssets: available,
            store,
            title: active.title,
            dirty: status !== "saved",
            failed: ["failed", "conflict", "rejected"].includes(status),
            saving: status === "saving",
            departing: departure !== null || busy,
            save,
            leave: () => setDeparture("home"),
            importFile,
            ...(!parseProgressContext(new URLSearchParams(location.search), projectId)
              ? { publish: () => setDeparture("publish") }
              : {}),
          }}
        />
      ) : (
        <main>
          <h1>Open project</h1>
          {loading && <p role="status">Opening your project...</p>}
          {!loading && !candidate && (
            <>
              <button onClick={() => setAttempt((value) => value + 1)}>Retry opening</button>{" "}
              <a href="/login">Log in</a>
            </>
          )}
        </main>
      )}
      {active && (
        <aside className="server-session" aria-label="Server project">
          <span role="status">{labels[status]}</span>
          {status === "failed" && (
            <button disabled={busy} onClick={() => void save()}>
              Retry Save
            </button>
          )}
          <button disabled={busy} onClick={() => void save(true)}>
            Export a Copy
          </button>
          <button disabled={busy} onClick={() => setDeparture("reload")}>
            Open Server Version
          </button>
          <button disabled={busy} onClick={() => setDeparture("logout")}>
            Log Out
          </button>
        </aside>
      )}
      {candidate && (
        <ChoiceDialog
          busy={busy}
          title="A recovery copy is available"
          cancel={() => {
            candidate.controller.abort();
            setCandidate(null);
          }}
        >
          <p>
            Choose which version to open. Recovering keeps the original save revision; a conflict
            will never overwrite someone else's work.
          </p>
          <button
            disabled={busy || !candidate.recovery?.serverSave}
            onClick={() => void run(() => install(candidate, true))}
          >
            Recover my edits
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const document = candidate.recovery?.document;
                if (!document) return;
                const encoded = serializeProject(document, kinds);
                if (!encoded.ok) throw new Error(encoded.error.message);
                await exportJson(encoded.value);
              })
            }
          >
            Export recovery copy
          </button>
          <button disabled={busy} onClick={() => void run(() => install(candidate, false))}>
            Use server version and discard recovery
          </button>
          <button
            disabled={busy}
            onClick={() => {
              candidate.controller.abort();
              setCandidate(null);
            }}
          >
            Cancel
          </button>
          {error && <p role="alert">{error}</p>}
        </ChoiceDialog>
      )}
      {departure && (
        <ChoiceDialog
          busy={busy}
          title="Are you sure?"
          cancel={() => {
            if (!busy) setDeparture(null);
          }}
        >
          <p>Your project will be saved before you exit.</p>
          <div>
            <button
              disabled={busy}
              onClick={() => void leave("cancel")}
              autoFocus
              data-initial-focus
            >
              Cancel
            </button>
            <button disabled={busy} onClick={() => void leave("save")}>
              {busy ? "Please wait…" : "Exit"}
            </button>
          </div>
          {error && (
            <div>
              <button disabled={busy} onClick={() => void leave("recovery")}>
                Keep Recovery and Exit
              </button>
              <button disabled={busy} onClick={() => void leave("export")}>
                Export and Exit
              </button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </ChoiceDialog>
      )}
      {error && !candidate && !departure && (
        <p className="server-session-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
