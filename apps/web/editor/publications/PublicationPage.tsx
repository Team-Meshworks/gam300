import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import { createAccountClient } from "../accounts/account-client";
import { createWorkspaceClient, isId, isRecord } from "../home/workspace-api";
import { Button } from "../../shared/ui/Button";
import { PublicationShare } from "./PublicationShare";
import { PublicationAccess } from "./PublicationAccess";
import {
  publicationAcknowledgement,
  type PublicationAcknowledgement,
  type PublicationRequest,
} from "./publication-client";
import "./publication.css";

const api = createWorkspaceClient();
const accounts = createAccountClient();
type Saved = { title: string; revision: number; canPublish: boolean };
type Readiness = {
  state: string;
  completionConfirmed: boolean | null;
  approved: boolean | null;
  missingCapabilities: { capability: string; path: string }[];
};
const readinessMessages: Record<string, string> = {
  Ready: "The saved revision is ready. Publishing checks these prerequisites again.",
  ApprovalRequired: "Educator approval of this saved revision is required before publishing.",
  UnsupportedRuntime:
    "This project's content cannot be published by the current visitor application.",
  InvalidDocument: "The saved project's content is invalid and cannot be published.",
  InvalidAssets: "The saved project's assets are unavailable for publication.",
  DependencyUnavailable:
    "Publishing is unavailable for this project until its origin and required services can be verified.",
  PolicyDenied: "Publication is unavailable under the current project policy.",
};
type Viewer = { userId: string; userName: string };
const problems = {
  revision_conflict:
    "The saved project has changed. Refresh and confirm the latest revision before publishing.",
  approval_required:
    "This class project needs approval for the current saved revision before it can be published.",
  publication_id_conflict:
    "This publication request conflicts with an existing one. Refresh before continuing.",
  publication_assets_unavailable: "The saved project's assets are not available for publication.",
  invalid_document: "The saved project is not valid for publication.",
  unsupported_publication_runtime: "This project cannot be published by the current runtime.",
};
const uncertainMessage =
  "The publication result could not be confirmed. Retry this same request to check its outcome.";
const storageMessage =
  "The browser could not safely store the publication request. Check browser storage before continuing.";

function pendingRequest(key: string | null): {
  request: PublicationRequest | null;
  error: boolean;
} {
  if (!key) return { request: null, error: false };
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { request: null, error: false };
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      !isId(value.publicationId) ||
      !Number.isSafeInteger(value.confirmedRevision) ||
      (value.confirmedRevision as number) < 0 ||
      !isRecord(value.intent) ||
      value.intent.audience !== "Authenticated" ||
      !Array.isArray(value.intent.viewerIds) ||
      value.intent.viewerIds.length > 100 ||
      !value.intent.viewerIds.every(isId) ||
      new Set(value.intent.viewerIds.map((id: string) => id.toLowerCase())).size !==
        value.intent.viewerIds.length ||
      Object.keys(value).length !== 3 ||
      Object.keys(value.intent).length !== 2
    )
      return { request: null, error: true };
    return { request: value as unknown as PublicationRequest, error: false };
  } catch {
    return { request: null, error: true };
  }
}

export function PublicationPage({
  session,
  onGuard,
}: {
  session: AccountSession;
  onGuard: (guard: LeaveGuard) => void;
}) {
  const params = new URLSearchParams(location.search).getAll("projectId");
  const projectId = params.length === 1 && isId(params[0]) ? params[0] : null;
  const storageKey = projectId
    ? `spatia-publication:${session.userId.toLowerCase()}:${projectId.toLowerCase()}`
    : null;
  const [pending] = useState(() => pendingRequest(storageKey));
  const [saved, setSaved] = useState<Saved | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [readinessError, setReadinessError] = useState("");
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(
    pending.error ? storageMessage : pending.request ? uncertainMessage : "",
  );
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [viewersLoading, setViewersLoading] = useState(true);
  const [viewersError, setViewersError] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<
    "ready" | "pending" | "unknown" | "success" | "stale" | "storage-error"
  >(pending.error ? "storage-error" : pending.request ? "unknown" : "ready");
  const [request, setRequest] = useState<PublicationRequest | null>(pending.request);
  const [ack, setAck] = useState<PublicationAcknowledgement | null>(null);
  const [shareAvailable, setShareAvailable] = useState(true);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) return;
    void (async () => {
      try {
        const value = await api.read(`/api/v1/projects/${encodeURIComponent(projectId)}`);
        const current = await accounts.getSession();
        if (current?.userId !== session.userId || current.mustChangePassword)
          throw new Error("Your account changed. Sign in again before continuing.");
        if (
          !isRecord(value) ||
          value.projectId !== projectId ||
          !Number.isSafeInteger(value.revision) ||
          (value.revision as number) < 0 ||
          !isRecord(value.document) ||
          typeof value.document.title !== "string" ||
          !value.document.title.trim() ||
          !isRecord(value.permissions) ||
          typeof value.permissions.canPublish !== "boolean"
        )
          throw new Error("The saved project could not be verified. Refresh before continuing.");
        if (!cancelled) {
          setSaved({
            title: value.document.title,
            revision: value.revision as number,
            canPublish: value.permissions.canPublish,
          });
          if (value.permissions.canPublish) {
            try {
              const status = await api.read(
                `/api/v1/projects/${encodeURIComponent(projectId)}/publication-readiness`,
              );
              const latestSession = await accounts.getSession();
              if (
                latestSession?.userId !== session.userId ||
                latestSession.mustChangePassword ||
                !isRecord(status) ||
                status.projectId !== projectId ||
                status.revision !== value.revision ||
                typeof status.state !== "string" ||
                !Object.hasOwn(readinessMessages, status.state) ||
                !(
                  status.completionConfirmed === null ||
                  typeof status.completionConfirmed === "boolean"
                ) ||
                !(status.approved === null || typeof status.approved === "boolean") ||
                (status.state === "Ready" &&
                  (status.approved === false || status.completionConfirmed === false))
              )
                throw new Error("Readiness changed");
              // Keep the server's ordered capability reasons beside the saved revision
              // Older responses may omit them; malformed details cannot become UI content
              const missing = status.missingCapabilities ?? [];
              if (
                !Array.isArray(missing) ||
                !missing.every(
                  (issue) =>
                    isRecord(issue) &&
                    typeof issue.capability === "string" &&
                    typeof issue.path === "string",
                )
              ) {
                throw new Error("Readiness details could not be verified");
              }
              if (!cancelled) {
                setReadiness({
                  state: status.state,
                  completionConfirmed: status.completionConfirmed,
                  approved: status.approved,
                  missingCapabilities: missing,
                });
              }
            } catch {
              if (!cancelled)
                setReadinessError(
                  "Publication readiness could not be verified. Refresh the saved revision before publishing.",
                );
            }
          }
        }
      } catch (failure) {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : "The saved project could not be loaded.",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const rows = await api.pages(
          `/api/v1/projects/${encodeURIComponent(projectId)}/publication-viewers`,
        );
        const seen = new Set<string>();
        const eligible = rows
          .map((row) => {
            if (
              !isRecord(row) ||
              !isId(row.userId) ||
              typeof row.userName !== "string" ||
              !row.userName.trim() ||
              seen.has(row.userId)
            )
              throw new Error("The viewer list could not be verified.");
            seen.add(row.userId);
            return { userId: row.userId, userName: row.userName };
          })
          .filter((viewer) => viewer.userId !== session.userId);
        const current = await accounts.getSession();
        if (current?.userId !== session.userId || current.mustChangePassword)
          throw new Error("Account changed");
        if (!cancelled) setViewers(eligible);
      } catch {
        if (!cancelled) setViewersError(true);
      } finally {
        if (!cancelled) setViewersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, session.userId]);

  useEffect(() => {
    onGuard({
      pending: phase === "pending",
      dirty: phase === "unknown" || (phase === "ready" && (confirmed || selected.length > 0)),
    });
  }, [onGuard, phase, confirmed, selected.length]);
  useEffect(() => {
    if (phase !== "pending" && phase !== "unknown") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [phase]);

  async function publish(retry = false) {
    if (
      inFlight.current ||
      !saved ||
      !projectId ||
      !saved.canPublish ||
      (!retry && (!confirmed || phase !== "ready" || readiness?.state !== "Ready")) ||
      (retry && (phase !== "unknown" || !request))
    )
      return;
    const payload: PublicationRequest =
      retry && request
        ? request
        : {
            publicationId: crypto.randomUUID(),
            confirmedRevision: saved.revision,
            intent: { audience: "Authenticated", viewerIds: [...selected].sort() },
          };
    try {
      if (!storageKey) throw new Error("Missing key");
      const encoded = JSON.stringify(payload);
      sessionStorage.setItem(storageKey, encoded);
      if (sessionStorage.getItem(storageKey) !== encoded)
        throw new Error("Storage could not be verified");
    } catch {
      setError(storageMessage);
      return;
    }
    setRequest(payload);
    inFlight.current = true;
    setPhase("pending");
    setError("");
    const result = await api.write(
      session.userId,
      `/api/v1/projects/${encodeURIComponent(projectId)}/publications`,
      "POST",
      payload,
      problems,
    );
    inFlight.current = false;
    if (result.kind === "confirmed") {
      const receipt = publicationAcknowledgement(result.value, projectId, payload);
      if (receipt) {
        try {
          sessionStorage.removeItem(storageKey!);
        } catch {
          /* A replay of the same ID remains safe. */
        }
        setAck(receipt);
        setShareAvailable(true);
        setPhase("success");
        return;
      }
    }
    if (result.kind === "rejected") {
      if (retry) {
        setError(`${result.message} The earlier publication outcome is still unconfirmed.`);
        setPhase("unknown");
        return;
      }
      try {
        sessionStorage.removeItem(storageKey!);
        if (sessionStorage.getItem(storageKey!) !== null)
          throw new Error("Storage could not be cleared");
      } catch {
        setError(storageMessage);
        setPhase("storage-error");
        return;
      }
      setError(result.message);
      setRequest(null);
      setConfirmed(false);
      setPhase(
        result.code === "revision_conflict" ||
          result.message === "The record changed or already exists. Refresh before trying again."
          ? "stale"
          : "ready",
      );
    } else {
      setError(uncertainMessage);
      setPhase("unknown");
    }
  }

  return (
    <section className="sp-publication" aria-label="Publication settings">
      {!projectId && <p role="alert">Choose a valid project before publishing.</p>}
      <p>
        Publish a saved revision for selected signed-in viewers. The publisher can also view it.
        Unsaved edits, including unsaved recovery edits, are not included. Later edits will not
        change this published edition.
      </p>
      {loading && <p role="status">Loading saved project…</p>}
      {error && <p role="alert">{error}</p>}
      {saved && (
        <>
          <h2>{saved.title}</h2>
          <p>Saved revision {saved.revision}</p>
          {saved.canPublish && phase !== "success" && (
            <section aria-label="Publication prerequisites">
              <h3>Publication prerequisites</h3>
              {loading && <p role="status">Checking publication readiness…</p>}
              {readinessError && <p role="alert">{readinessError}</p>}
              {readiness && (
                <>
                  {readiness.completionConfirmed !== null && (
                    <p>
                      Completion:{" "}
                      {readiness.completionConfirmed
                        ? "confirmed for this saved revision"
                        : "confirm completion and submit this saved revision"}
                      .
                    </p>
                  )}
                  {readiness.approved !== null && (
                    <p>
                      Approval:{" "}
                      {readiness.approved
                        ? "approved for this saved revision"
                        : "not approved for this saved revision"}
                      .
                    </p>
                  )}
                  <p>{readinessMessages[readiness.state]}</p>
                  {readiness.state === "UnsupportedRuntime" &&
                    readiness.missingCapabilities.length > 0 && (
                      <>
                        <p>
                          These features are not available in the visitor yet. Your saved content is
                          unchanged.
                        </p>
                        <ul aria-label="Unavailable publication features">
                          {readiness.missingCapabilities.map((issue) => (
                            <li key={`${issue.path}:${issue.capability}`}>
                              {issue.capability} — {issue.path}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  {readiness.state === "ApprovalRequired" && session.role !== "Administrator" && (
                    <a href={`/review?projectId=${encodeURIComponent(projectId!)}`}>
                      Open submissions and reviews
                    </a>
                  )}
                </>
              )}
              <Button
                disabled={phase === "pending" || phase === "unknown"}
                onClick={() => location.reload()}
              >
                Refresh saved revision
              </Button>
            </section>
          )}
          {!saved.canPublish ? (
            <p>You do not have permission to publish this project.</p>
          ) : phase === "success" && ack ? (
            <div>
              <p role="status">Published saved revision {ack.sourceRevision}.</p>
              {shareAvailable ? (
                <>
                  <a href={ack.visitorUrl}>Open publication</a>
                  <PublicationShare url={ack.visitorUrl} />
                </>
              ) : (
                <p>Sharing is unavailable for this publication.</p>
              )}
            </div>
          ) : (
            <>
              <fieldset disabled={phase !== "ready" || viewersLoading}>
                <legend>Signed-in viewers</legend>
                <p>Choose up to 100 viewers.</p>
                {viewersLoading && <p role="status">Loading viewers…</p>}
                {viewersError && (
                  <p>Viewers could not be loaded. You can publish for yourself only.</p>
                )}
                {!viewersLoading && !viewersError && viewers.length === 0 && (
                  <p>No other viewers are available to select.</p>
                )}
                {viewers.map((viewer) => (
                  <label key={viewer.userId}>
                    <input
                      type="checkbox"
                      checked={selected.includes(viewer.userId)}
                      disabled={selected.length >= 100 && !selected.includes(viewer.userId)}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, viewer.userId]
                            : previous.filter((id) => id !== viewer.userId),
                        )
                      }
                    />{" "}
                    {viewer.userName}
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />{" "}
                  I confirm this saved revision is ready to publish.
                </label>
              </fieldset>
              {phase === "unknown" ? (
                <Button onClick={() => void publish(true)}>Retry publication</Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={
                    phase !== "ready" ||
                    !confirmed ||
                    viewersLoading ||
                    loading ||
                    readiness?.state !== "Ready"
                  }
                  onClick={() => void publish()}
                >
                  {phase === "pending" ? "Publishing…" : "Publish"}
                </Button>
              )}
              <Button
                disabled={phase === "pending" || phase === "unknown"}
                onClick={() => location.assign("/home")}
              >
                Cancel
              </Button>
            </>
          )}
          <PublicationAccess
            key={`${session.userId}:${projectId}:${ack?.publicationId ?? "existing"}`}
            projectId={projectId!}
            session={session}
            initialId={ack?.publicationId}
            onAvailabilityChange={(id, available) => {
              if (ack?.publicationId.toLowerCase() === id.toLowerCase())
                setShareAvailable(available);
            }}
          />
        </>
      )}
    </section>
  );
}
