import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import { createDirectoryClient, type ManagedOrganization } from "../directory/directory-client";
import type { FormNavigationState } from "../projects/NewProjectForm";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import { Select } from "../../shared/ui/Select";
import { createWorkspaceClient, isId, projectReceipt } from "./workspace-api";
import { isRecord } from "../../shared/project/validation-helpers";

import {
  finishConfirmedCreation,
  createOperationKey,
  readCreateOperation,
  sendCreateOperation,
} from "./create-operation";

import { PendingCreateRecovery } from "./PendingCreateRecovery";

const api = createWorkspaceClient();
const accounts = createAccountClient();
const directory = createDirectoryClient();

export function ProjectCreation({
  session,
  active,
  onNavigationStateChange,
}: {
  session: AccountSession;
  active: boolean;
  onNavigationStateChange?: ((state: FormNavigationState) => void) | undefined;
}) {
  const [spaces, setSpaces] = useState<{ id: string; name: string }[] | null>(null);
  const [spaceError, setSpaceError] = useState(false);
  const [organizations, setOrganizations] = useState<ManagedOrganization[]>([]);
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [title, setTitle] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [orgId, setOrgId] = useState("");
  const [phase, setPhase] = useState<"ready" | "pending" | "unknown" | "created">("ready");
  const recoveryKey = `spatia:uncertain-project-creation:${session.userId}`;
  const needsCheck = (() => {
    try {
      return sessionStorage.getItem(recoveryKey) !== null;
    } catch {
      return true;
    }
  })();
  const operationKey = createOperationKey(session.userId, "project");
  const [recoverable, setRecoverable] = useState(true);
  const [message, setMessage] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const busy = useRef(false);
  const dirty = open && phase === "ready" && Boolean(title || spaceId || orgId);
  useLayoutEffect(() => {
    onNavigationStateChange?.({ dirty, locked: phase === "pending" });
  }, [dirty, phase, onNavigationStateChange]);
  useEffect(
    () => () => onNavigationStateChange?.({ dirty: false, locked: false }),
    [onNavigationStateChange],
  );
  useEffect(() => {
    if (!createdId) return;
    const frame = requestAnimationFrame(() =>
      location.assign(`/?projectId=${encodeURIComponent(createdId)}`),
    );
    return () => cancelAnimationFrame(frame);
  }, [createdId]);
  useEffect(() => {
    if (!dirty && phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, phase]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rows, orgs] = await Promise.all([
          api
            .read("/api/v1/assets")
            .then((value) => {
              if (!Array.isArray(value)) throw new Error("Invalid catalogue");
              return value
                .filter(
                  (row: unknown) => isRecord(row) && "kind" in row && row.kind === "environment",
                )
                .map((row: unknown) => {
                  if (
                    !isRecord(row) ||
                    !("id" in row) ||
                    !("name" in row) ||
                    !isId(row.id) ||
                    typeof row.name !== "string" ||
                    !row.name.trim()
                  )
                    throw new Error("Invalid space");
                  return { id: row.id, name: row.name };
                });
            })
            .catch(() => null),
          session.role === "Administrator" ? directory.organizations() : Promise.resolve([]),
        ]);
        const current = await accounts.getSession();
        if (current?.userId !== session.userId || current.mustChangePassword)
          throw new Error("Account changed");
        if (!cancelled) {
          setSpaces(rows ?? []);
          setSpaceError(rows === null);
          setOrganizations(orgs.filter((org) => org.isActive));
          setLoadError("");
        }
      } catch {
        if (!cancelled)
          setLoadError(
            "Your account or organisations could not be verified. Retry before creating a project.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.userId, session.role, version]);
  function close() {
    if (busy.current) return;
    if (dirty) {
      setDiscard(true);
      return;
    }
    setOpen(false);
  }
  async function create(retry = false) {
    if (
      !active ||
      (needsCheck && !retry) ||
      busy.current ||
      (!retry &&
        (recoverable ||
          phase !== "ready" ||
          !title.trim() ||
          (spaceId !== "" && !spaces?.some((space) => space.id === spaceId)) ||
          (session.role === "Administrator" && !organizations.some((org) => org.id === orgId))))
    )
      return;
    busy.current = true;
    setPhase("pending");
    setMessage("");
    const outcome = await sendCreateOperation(
      localStorage,
      operationKey,
      session.userId,
      api.write,
      projectReceipt,
      retry
        ? undefined
        : {
            path: "/api/v1/projects",
            body: {
              title: title.trim(),
              ...(spaceId ? { environmentAssetId: spaceId } : {}),
              ...(session.role === "Administrator" ? { orgId } : {}),
            },
          },
    );
    if (!retry && outcome.kind === "confirmed")
      await finishConfirmedCreation(
        localStorage,
        session.userId,
        "project",
        outcome.value,
        api.write,
      );
    busy.current = false;
    try {
      setRecoverable(readCreateOperation(localStorage, operationKey, session.userId) !== null);
    } catch {
      setRecoverable(true);
    }
    if (outcome.kind === "confirmed" && projectReceipt(outcome.value) && isRecord(outcome.value)) {
      setPhase("created");
      setCreatedId(String(outcome.value.projectId));
    } else if (outcome.kind === "rejected") {
      setPhase("ready");
      setMessage(outcome.message);
    } else {
      setPhase("unknown");
      setMessage(
        "Creation could not be confirmed. Retry the saved request to recover the same project.",
      );
    }
  }
  const unavailable =
    !active ||
    needsCheck ||
    recoverable ||
    !!loadError ||
    (session.role !== "Administrator" && !session.orgId) ||
    (session.role === "Administrator" && !organizations.length);
  const creator = session.role === "Creator";
  // Keep the submit guard when creator actions sit outside the disabled fieldset
  const createButton = (
    <Button
      type="submit"
      variant="primary"
      disabled={!active || needsCheck || recoverable || phase !== "ready"}
    >
      Create project
    </Button>
  );
  const cancelButton = (
    <Button disabled={phase === "pending"} onClick={close}>
      {phase === "unknown" ? "Back to projects" : "Cancel"}
    </Button>
  );
  const discardActions = (
    <>
      <Button
        onClick={() => {
          setDiscard(false);
          setOpen(false);
          setTitle("");
          setSpaceId("");
          setOrgId("");
        }}
      >
        Discard details
      </Button>
      <Button variant="primary" onClick={() => setDiscard(false)}>
        Keep editing
      </Button>
    </>
  );
  const canRetry = (() => {
    try {
      const operation = readCreateOperation(localStorage, operationKey, session.userId);
      return operation !== null && !operation.receipt;
    } catch {
      return false;
    }
  })();
  const recoveryPanel = (
    <PendingCreateRecovery
      actorId={session.userId}
      purpose="project"
      refreshKey={phase + message}
      onPendingChange={setRecoverable}
      onRecovered={(value) => {
        setCreatedId(value.id);
        setPhase("created");
      }}
      active={active && phase !== "pending"}
      onReleased={() => {
        setPhase("ready");
        setMessage(
          "The saved request was released. Its outcome remains unknown. A new project is a separate creation.",
        );
      }}
    />
  );
  return (
    <div>
      <Button
        disabled={unavailable}
        onClick={() => {
          setOpen(true);
          setPhase("ready");
          setMessage("");
          setTitle("");
          setSpaceId("");
          setOrgId("");
        }}
      >
        New project
      </Button>
      {canRetry && !open && (
        <p role="alert">
          {message ||
            "An earlier project creation needs confirmation. Retry its saved request to recover the same project."}
          <Button
            disabled={!active || phase === "pending" || needsCheck}
            onClick={() => void create(true)}
          >
            Retry same project
          </Button>
        </p>
      )}
      {!open && recoveryPanel}
      {loadError ? (
        <p role="alert">
          {loadError} <Button onClick={() => setVersion((value) => value + 1)}>Retry</Button>
        </p>
      ) : session.role !== "Administrator" && !session.orgId ? (
        <p role="status">An active organisation is required to create a project.</p>
      ) : spaces === null ? (
        <LoadingSkeleton label="Loading approved 3D spaces" layout="cards" />
      ) : session.role === "Administrator" && organizations.length === 0 ? (
        <p role="status">An active organisation is required to create a project.</p>
      ) : spaceError ? (
        <p role="status">
          Available 3D spaces could not be loaded. You can start with an empty scene.{" "}
          <Button onClick={() => setVersion((value) => value + 1)}>Retry spaces</Button>
        </p>
      ) : spaces.length === 0 ? (
        <p role="status">Start with an empty scene. You can add a 3D space later.</p>
      ) : null}
      {open && (
        <Dialog
          title="New project"
          onClose={close}
          {...(creator ? { variant: "admin" as const } : {})}
          className={creator ? "sp-creator-project-dialog" : ""}
          closeDisabled={phase === "pending"}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
            aria-busy={phase === "pending"}
          >
            <p>Start with an empty scene, or choose an available 3D space.</p>
            {!spaceId && (
              <p>Empty projects can be edited and assigned, but publishing is not yet available.</p>
            )}
            {message && <p role="alert">{message}</p>}
            {canRetry && phase !== "pending" && (
              <Button onClick={() => void create(true)}>Retry same project</Button>
            )}
            {phase === "pending" && <p role="status">Creating project… Keep this page open.</p>}
            <fieldset
              className="sp-home-fields"
              disabled={!active || needsCheck || phase !== "ready"}
            >
              <legend className="sp-sr-only">Project details</legend>
              <Field id="blank-project-title" label="Project title" required>
                <input
                  id="blank-project-title"
                  ref={(input) => {
                    // Native dialog opening needs an autofocus target before its first focus pass
                    if (input && creator) input.autofocus = true;
                  }}
                  required
                  maxLength={256}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              {creator ? (
                <Select
                  label="3D space (optional)"
                  value={spaceId}
                  options={[
                    { value: "", label: "Empty scene" },
                    ...(spaces ?? []).map((space) => ({
                      value: space.id,
                      label: space.name,
                    })),
                  ]}
                  onChange={setSpaceId}
                  disabled={!active || needsCheck || phase !== "ready"}
                  className="sp-creator-space"
                  menuClassName="sp-creator-space-menu"
                />
              ) : (
                <Field id="blank-project-space" label="3D space (optional)">
                  <select
                    id="blank-project-space"
                    value={spaceId}
                    onChange={(event) => setSpaceId(event.target.value)}
                  >
                    <option value="">Empty scene</option>
                    {spaces?.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {session.role === "Administrator" && (
                <Field id="blank-project-organisation" label="Organisation" required>
                  <select
                    id="blank-project-organisation"
                    required
                    value={orgId}
                    onChange={(event) => setOrgId(event.target.value)}
                  >
                    <option value="">Choose an organisation</option>
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {!creator && createButton}
            </fieldset>
            {recoveryPanel}
            {creator ? (
              <div className="sp-actions">
                {cancelButton}
                {createButton}
              </div>
            ) : (
              cancelButton
            )}
          </form>
        </Dialog>
      )}
      {discard && (
        <Dialog
          title="Discard new project details?"
          onClose={() => setDiscard(false)}
          {...(creator ? { variant: "admin" as const } : {})}
          className={creator ? "sp-creator-project-dialog" : ""}
        >
          <p>No project has been created. Your entered details will be discarded.</p>
          {creator ? <div className="sp-actions">{discardActions}</div> : discardActions}
        </Dialog>
      )}
    </div>
  );
}
