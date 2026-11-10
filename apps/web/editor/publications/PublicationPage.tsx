import { Icon } from "@iconify/react/offline";
import check from "@iconify-icons/lucide/check";
import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import { createAccountClient } from "../accounts/account-client";
import { createWorkspaceClient, isId, isRecord } from "../home/workspace-api";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { SearchField } from "../../shared/ui/SearchField";
import { PublishStatus } from "./PublishStatus";
import { PublicationShare } from "./PublicationShare";
import { PublicationAccess } from "./PublicationAccess";
import {
  isDefinitivePublicationRejection,
  publicationAcknowledgement,
  publicationProblems,
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
      !["Authenticated", "Unlisted", "Public"].includes(String(value.intent.audience)) ||
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
  projectId: requestedProjectId,
  onGuard,
  onCancel,
}: {
  session: AccountSession;
  projectId?: string;
  onGuard: (guard: LeaveGuard) => void;
  onCancel?: () => void;
}) {
  const params = new URLSearchParams(location.search).getAll("projectId");
  const projectId =
    requestedProjectId !== undefined
      ? isId(requestedProjectId)
        ? requestedProjectId
        : null
      : params.length === 1 && isId(params[0])
        ? params[0]
        : null;
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
  const [viewersLoading, setViewersLoading] = useState(!onCancel);
  const [viewersError, setViewersError] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [viewerQuery, setViewerQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<
    "ready" | "pending" | "unknown" | "success" | "stale" | "storage-error"
  >(pending.error ? "storage-error" : pending.request ? "unknown" : "ready");
  const [request, setRequest] = useState<PublicationRequest | null>(pending.request);
  const modal = Boolean(onCancel);
  const [audience, setAudience] = useState(
    pending.request?.intent.audience ?? (onCancel ? "Unlisted" : "Authenticated"),
  );
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
      if (modal) return;
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
  }, [projectId, session.userId, modal]);

  useEffect(() => {
    const pending = phase === "pending";
    const dirty = phase === "unknown" || (phase === "ready" && (confirmed || selected.length > 0));
    onGuard({ pending, dirty });
    if (!pending && !dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [onGuard, phase, confirmed, selected.length]);

  useEffect(() => {
    // Wait for the pending navigation guard to clean up before leaving with a verified receipt
    if (phase === "success" && ack && session.role === "Creator" && modal)
      location.assign("/home?tab=published");
  }, [phase, ack, session.role, modal]);

  const visibleViewers = viewers.filter(
    (viewer) =>
      viewer.userName.toLocaleLowerCase().includes(viewerQuery.trim().toLocaleLowerCase()) &&
      (!selectedOnly || selected.includes(viewer.userId)),
  );
  const matchingIds = [...new Set([...selected, ...visibleViewers.map((viewer) => viewer.userId)])];

  async function publish(retry = false) {
    if (
      inFlight.current ||
      !saved ||
      !projectId ||
      !saved.canPublish ||
      (!retry &&
        ((!onCancel && !confirmed) || phase !== "ready" || readiness?.state !== "Ready")) ||
      (retry && (phase !== "unknown" || !request))
    )
      return;
    const payload: PublicationRequest =
      retry && request
        ? request
        : {
            publicationId: crypto.randomUUID(),
            confirmedRevision: saved.revision,
            intent: {
              audience,
              viewerIds: audience === "Authenticated" ? [...selected].sort() : [],
            },
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
      publicationProblems,
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
      if (!isDefinitivePublicationRejection(result.code, retry)) {
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

  if (onCancel)
    return (
      <PublishStatus
        state={
          loading || !readiness
            ? "checking"
            : readiness.completionConfirmed === false
              ? "incomplete"
              : readiness?.approved === false
                ? "pending"
                : "approved"
        }
        titleId="creator-publish-title"
        closeLabel="Close publish project"
        onClose={onCancel}
        locked={phase === "pending"}
        actions={
          <>
            <Button disabled={phase === "pending" || phase === "unknown"} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                phase === "pending" ||
                (phase !== "unknown" &&
                  (phase !== "ready" ||
                    loading ||
                    !saved?.canPublish ||
                    readiness?.state !== "Ready"))
              }
              onClick={() => void publish(phase === "unknown")}
            >
              {phase === "pending"
                ? "Publishing…"
                : phase === "unknown"
                  ? "Retry publication"
                  : "Publish Project"}
            </Button>
          </>
        }
      >
        {loading && (
          <p role="status" className="publish-status-loading">
            Preparing your saved project…
          </p>
        )}
        {(error ||
          readinessError ||
          (readiness && readiness.state !== "Ready") ||
          (saved && !saved.canPublish)) && (
          <p role="alert" className="creator-approval-error">
            {error ||
              readinessError ||
              (saved && !saved.canPublish
                ? "You do not have permission to publish this project."
                : readinessMessages[readiness!.state])}
          </p>
        )}
      </PublishStatus>
    );

  return (
    <section className="sp-publication" aria-label="Publication settings">
      {!projectId && <p role="alert">Choose a valid project before publishing.</p>}
      {!onCancel && (
        <p>
          Publish a saved revision for selected signed-in viewers. The publisher can also view it.
          Unsaved edits, including unsaved recovery edits, are not included. Later edits will not
          change this published edition.
        </p>
      )}
      {loading && <p role="status">Loading saved project…</p>}
      {error && <p role="alert">{error}</p>}
      {saved && (
        <>
          <h2>{saved.title}</h2>
          {!onCancel && <p>Saved revision {saved.revision}</p>}
          {onCancel &&
            saved.canPublish &&
            phase !== "success" &&
            (readinessError || (readiness && readiness.state !== "Ready")) && (
              <p role="alert">{readinessError || readinessMessages[readiness!.state]}</p>
            )}
          {!onCancel && saved.canPublish && phase !== "success" && (
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
                  <PublicationShare
                    url={ack.visitorUrl}
                    unlisted={(request?.intent.audience ?? audience) !== "Authenticated"}
                  />
                </>
              ) : (
                <p>Sharing is unavailable for this publication.</p>
              )}
            </div>
          ) : (
            <>
              <fieldset disabled={phase !== "ready" || viewersLoading}>
                <legend>Publication audience</legend>
                <div className="sp-publication-audience-field">
                  {onCancel ? (
                    <Select
                      label="Who can open this publication"
                      value={audience}
                      className="creator-publication-select"
                      showSelectedIcon={false}
                      menuClassName="creator-publication-options"
                      options={[
                        { value: "Authenticated", label: "Permitted signed-in accounts" },
                        { value: "Unlisted", label: "Anyone with the link" },
                        { value: "Public", label: "Anyone without signing in" },
                      ]}
                      disabled={phase !== "ready" || viewersLoading}
                      onChange={(value) => {
                        setAudience(value);
                        setConfirmed(false);
                      }}
                    />
                  ) : (
                    <label>
                      Who can open this publication
                      <select
                        value={audience}
                        onChange={(event) => {
                          setAudience(event.target.value);
                          setConfirmed(false);
                        }}
                      >
                        <option value="Authenticated">Permitted signed-in accounts</option>
                        <option value="Unlisted">Anyone with the link</option>
                        <option value="Public">Anyone without signing in</option>
                      </select>
                    </label>
                  )}
                </div>
                {(!onCancel || audience !== "Authenticated") && (
                  <p>
                    {audience === "Authenticated"
                      ? "Choose permitted accounts below"
                      : audience === "Unlisted"
                        ? "Unlisted is not private; anyone holding the link can open it"
                        : "Anyone can open this publication without an account"}
                  </p>
                )}
                {audience === "Authenticated" && (
                  <>
                    {!onCancel && <p>Choose up to 100 viewers.</p>}
                    {viewersLoading && <p role="status">Loading viewers…</p>}
                    {viewersError && (
                      <p>Viewers could not be loaded. You can publish for yourself only.</p>
                    )}
                    {!viewersLoading && !viewersError && viewers.length === 0 && (
                      <p>No other viewers are available to select.</p>
                    )}
                    {onCancel && !viewersLoading && !viewersError && viewers.length > 0 ? (
                      <div className="creator-viewer-picker">
                        <div className="creator-viewer-heading">
                          <strong>Viewers</strong>
                          <span role="status">{selected.length} / 100 selected</span>
                        </div>
                        <SearchField
                          label="Search viewers"
                          placeholder="Search accounts"
                          value={viewerQuery}
                          onChange={setViewerQuery}
                        />
                        <div className="creator-viewer-tools">
                          <button
                            type="button"
                            aria-pressed={selectedOnly}
                            onClick={() => setSelectedOnly(!selectedOnly)}
                          >
                            Selected ({selected.length})
                          </button>
                          <div>
                            <button
                              type="button"
                              disabled={
                                !visibleViewers.length ||
                                matchingIds.length > 100 ||
                                matchingIds.length === selected.length
                              }
                              onClick={() => {
                                setSelected(matchingIds);
                                setConfirmed(false);
                              }}
                            >
                              {viewerQuery.trim() ? "Select matches" : "Select all"}
                            </button>
                            <button
                              type="button"
                              disabled={!selected.length}
                              onClick={() => {
                                setSelected([]);
                                setConfirmed(false);
                              }}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div
                          className="creator-viewer-list"
                          // Base height on eligible accounts so searching does not make the popup jump
                          style={{ height: Math.min(viewers.length, 4) * 36 + 26 }}
                          role="group"
                          aria-label="Publication viewers"
                        >
                          <div className="creator-viewer-scroll">
                            {visibleViewers.map((viewer) => (
                              <button
                                type="button"
                                key={viewer.userId}
                                aria-pressed={selected.includes(viewer.userId)}
                                disabled={
                                  !selected.includes(viewer.userId) && selected.length >= 100
                                }
                                onClick={() => {
                                  setSelected((previous) =>
                                    previous.includes(viewer.userId)
                                      ? previous.filter((id) => id !== viewer.userId)
                                      : [...previous, viewer.userId],
                                  );
                                  setConfirmed(false);
                                }}
                              >
                                <span>{viewer.userName}</span>
                                {selected.includes(viewer.userId) && (
                                  <Icon icon={check} width={16} aria-hidden="true" />
                                )}
                              </button>
                            ))}
                            {!visibleViewers.length && (
                              <p role="status">
                                {selectedOnly && !selected.length
                                  ? "No viewers selected."
                                  : "No matching accounts."}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      !onCancel && (
                        <>
                          {viewers.map((viewer) => (
                            <label key={viewer.userId}>
                              <input
                                type="checkbox"
                                checked={selected.includes(viewer.userId)}
                                disabled={
                                  audience !== "Authenticated" ||
                                  (selected.length >= 100 && !selected.includes(viewer.userId))
                                }
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
                        </>
                      )
                    )}
                  </>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />{" "}
                  I confirm this saved revision is ready to publish.
                </label>
              </fieldset>
              <div className={onCancel ? "creator-approval-actions" : "sp-publication-actions"}>
                <Button
                  disabled={phase === "pending" || phase === "unknown"}
                  onClick={() => location.assign("/home")}
                >
                  Cancel
                </Button>
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
              </div>
            </>
          )}
          {!onCancel && (
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
          )}
        </>
      )}
    </section>
  );
}
