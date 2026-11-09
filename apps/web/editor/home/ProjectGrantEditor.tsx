import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import {
  projectGrantDraft,
  projectGrantReplacement,
  readProjectGrantEditor,
  type ProjectGrantDraft,
} from "./project-grants";
import { createWorkspaceClient, projectReceipt, type ProjectSummary } from "./workspace-api";

const api = createWorkspaceClient();
const emptyDraft = (): ProjectGrantDraft => ({
  managedByUserIds: [],
  assignedCreatorIds: [],
  canPublishUserIds: [],
});
const sameIds = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id) => right.includes(id));

export function ProjectGrantEditor({
  session,
  project,
  active,
  onClose,
  onSaved,
}: {
  session: AccountSession;
  project: ProjectSummary;
  active: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof readProjectGrantEditor>> | null>(
    null,
  );
  const [draft, setDraft] = useState<ProjectGrantDraft>(emptyDraft);
  const [version, setVersion] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "pending" | "unknown" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [discard, setDiscard] = useState<"close" | "reload" | null>(null);
  const inFlight = useRef(false);
  const initial = loaded ? projectGrantDraft(loaded.snapshot, loaded.accounts) : emptyDraft();
  const dirty =
    !sameIds(initial.managedByUserIds, draft.managedByUserIds) ||
    !sameIds(initial.assignedCreatorIds, draft.assignedCreatorIds) ||
    !sameIds(initial.canPublishUserIds, draft.canPublishUserIds);

  useEffect(() => {
    const controller = new AbortController();
    void readProjectGrantEditor(project.projectId, session.userId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setLoaded(value);
        setDraft(projectGrantDraft(value.snapshot, value.accounts));
        setMessage("");
        setPhase("ready");
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : "Project access is unavailable.");
        setPhase("error");
      },
    );
    return () => controller.abort();
  }, [project.projectId, session.userId, version]);

  useEffect(() => {
    if (!dirty && phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, phase]);

  function close() {
    if (inFlight.current) return;
    if (discard) setDiscard(null);
    else if (dirty && phase !== "unknown") setDiscard("close");
    else onClose();
  }

  function reload() {
    setDiscard(null);
    setLoaded(null);
    setDraft(emptyDraft());
    setPhase("loading");
    setMessage("");
    setVersion((value) => value + 1);
  }

  function toggle(field: keyof ProjectGrantDraft, id: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      [field]: checked ? [...current[field], id] : current[field].filter((value) => value !== id),
      ...(field === "assignedCreatorIds" && !checked
        ? { canPublishUserIds: current.canPublishUserIds.filter((value) => value !== id) }
        : {}),
    }));
  }

  async function save() {
    if (!loaded || phase !== "ready" || inFlight.current || !active) return;
    let body;
    try {
      body = projectGrantReplacement(loaded.snapshot, loaded.accounts, draft);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Check the selected access.");
      return;
    }
    inFlight.current = true;
    setPhase("pending");
    setMessage("");
    try {
      const result = await api.write(
        session.userId,
        `/api/v1/projects/${encodeURIComponent(project.projectId)}/assignments`,
        "PATCH",
        body,
      );
      if (
        result.kind === "confirmed" &&
        projectReceipt(result.value, { ...project, revision: loaded.snapshot.revision }, false)
      ) {
        onSaved();
      } else if (result.kind === "rejected") {
        setMessage(result.message);
        setPhase("ready");
      } else {
        setMessage("We could not confirm the change. Reload access before trying again.");
        setPhase("unknown");
      }
    } finally {
      inFlight.current = false;
    }
  }

  if (!active) return null;
  const choices =
    loaded?.accounts.filter(
      (row) => row.isActive && row.orgId === loaded.snapshot.organizationId,
    ) ?? [];
  return (
    <Dialog
      title={discard ? "Discard access changes?" : "Project access"}
      onClose={close}
      {...(session.role === "Administrator" ? { variant: "admin" as const } : {})}
    >
      {discard ? (
        <>
          <p>
            Your unsaved access choices will be discarded. Saved project access will stay unchanged.
          </p>
          <Button onClick={discard === "reload" ? reload : onClose}>Discard changes</Button>
          <Button autoFocus variant="primary" onClick={() => setDiscard(null)}>
            Keep editing
          </Button>
        </>
      ) : (
        <>
          <h3>{project.title}</h3>
          {phase === "loading" && <p role="status">Loading project access…</p>}
          {message && <p role="alert">{message}</p>}
          {loaded && phase !== "loading" && phase !== "error" && (
            <form
              aria-busy={phase === "pending"}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={phase !== "ready"} className="sp-home-fields">
                <legend className="sp-sr-only">Project access choices</legend>
                <p>Save replaces this project's assigned access with the choices below.</p>
                <fieldset className="sp-grant-options">
                  <legend>Educators</legend>
                  <p>Selected educators can edit, manage and publish this project.</p>
                  {choices
                    .filter((row) => row.role === "Educator")
                    .map((row) => (
                      <label key={row.userId}>
                        <input
                          type="checkbox"
                          checked={draft.managedByUserIds.includes(row.userId)}
                          onChange={(event) =>
                            toggle("managedByUserIds", row.userId, event.target.checked)
                          }
                        />
                        Manage access for {row.displayName} ({row.userName})
                      </label>
                    ))}
                </fieldset>
                <fieldset className="sp-grant-options">
                  <legend>Creators</legend>
                  {choices
                    .filter((row) => row.role === "Creator")
                    .map((row) => (
                      <div key={row.userId} className="sp-grant-person">
                        <label>
                          <input
                            type="checkbox"
                            checked={draft.assignedCreatorIds.includes(row.userId)}
                            onChange={(event) =>
                              toggle("assignedCreatorIds", row.userId, event.target.checked)
                            }
                          />
                          Edit project for {row.displayName} ({row.userName})
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            disabled={!draft.assignedCreatorIds.includes(row.userId)}
                            checked={draft.canPublishUserIds.includes(row.userId)}
                            onChange={(event) =>
                              toggle("canPublishUserIds", row.userId, event.target.checked)
                            }
                          />
                          Publish project for {row.displayName} ({row.userName})
                        </label>
                      </div>
                    ))}
                </fieldset>
                <Button type="submit" variant="primary" disabled={!dirty}>
                  {phase === "pending" ? "Saving access…" : "Save access"}
                </Button>
              </fieldset>
            </form>
          )}
          {phase !== "pending" && (
            <Button
              onClick={() => {
                if (dirty && phase !== "unknown") setDiscard("reload");
                else reload();
              }}
            >
              Reload access
            </Button>
          )}
        </>
      )}
    </Dialog>
  );
}
