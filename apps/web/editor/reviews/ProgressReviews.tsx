import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import {
  createProgressReviewClient,
  type ProgressIntent,
  type ProgressReview,
} from "./progress-review-client";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import { allPages, createReviewClient } from "./review-client";
import { mayDecide, reviewState, type Decision } from "./review-types";
import { loadStudentFeedback } from "../home/student-feedback";
import { createWorkspaceClient } from "../home/workspace-api";
import { createAccountClient } from "../accounts/account-client";
import { PublicationShare } from "../publications/PublicationShare";
import { publicationAccessState } from "../publications/publication-access";
import { withPublicationSession } from "./publication-session";
import "../publications/publication.css";
import {
  approveAndPublish,
  readApprovalPublication,
  type ApprovalPublicationIntent,
} from "./approve-publication";

const client = createProgressReviewClient();
const submissionClient = createReviewClient();
const workspace = createWorkspaceClient();
const accounts = createAccountClient();
type SubmissionFeedback = { id: string; feedback: string; decidedAt: string };
export function ProgressReviewList({
  items,
  decisions = [],
}: {
  items: ProgressReview[];
  decisions?: readonly SubmissionFeedback[];
}) {
  const entries = [
    ...items.map((item) => ({
      id: `progress:${item.id}`,
      feedback: item.feedback,
      at: item.createdAt,
    })),
    ...decisions
      .filter((item) => item.feedback.trim())
      .map((item) => ({ id: `decision:${item.id}`, feedback: item.feedback, at: item.decidedAt })),
  ];
  return (
    <div className="sp-progress-list">
      {entries
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
        .map((item) => (
          <article className="sp-progress-entry" key={item.id}>
            <time dateTime={item.at}>
              {new Date(item.at).toLocaleString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
            <p>{item.feedback}</p>
          </article>
        ))}
    </div>
  );
}

export function ProgressReviews({
  projectId,
  revision,
  actorId,
  orgId,
  educator,
  onGuard,
  autoOpen = false,
  startEditing = false,
  onClose,
  decisions = [],
  decisionsLoading = false,
  decisionsError = "",
  publication,
  onSaved,
}: {
  projectId: string;
  revision: number;
  actorId: string;
  orgId?: string | null;
  educator: boolean;
  onGuard: (guard: LeaveGuard) => void;
  autoOpen?: boolean;
  startEditing?: boolean;
  onClose?: () => void;
  decisions?: readonly SubmissionFeedback[];
  decisionsLoading?: boolean;
  decisionsError?: string;
  publication?: { studentId: string; studentName: string; projectTitle: string };
  onSaved?: () => void;
}) {
  const [items, setItems] = useState<ProgressReview[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(autoOpen);
  const [editing, setEditing] = useState(Boolean(publication) || startEditing);
  const [feedback, setFeedback] = useState("");
  const [intent, setIntent] = useState<ProgressIntent | null>(null);
  const [phase, setPhase] = useState<"ready" | "sending" | "unknown">("ready");
  const [conflict, setConflict] = useState(false);
  const [submission, setSubmission] = useState<{ id: string; revision: number } | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [approvalSaved, setApprovalSaved] = useState(false);
  const [submissionFeedback, setSubmissionFeedback] = useState<Decision[]>([]);
  const [publicationLoading, setPublicationLoading] = useState(Boolean(publication));
  const [publicationError, setPublicationError] = useState("");
  const [publicationAttempt, setPublicationAttempt] = useState(0);
  const [pendingPublication, setPendingPublication] = useState<ApprovalPublicationIntent | null>(
    null,
  );
  const [publishedUrl, setPublishedUrl] = useState("");
  const [legacyChecked, setLegacyChecked] = useState(false);
  const [legacyUnverified, setLegacyUnverified] = useState(false);
  const [legacyAcknowledged, setLegacyAcknowledged] = useState(false);
  const [legacyMessage, setLegacyMessage] = useState("");
  const active = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const publicationStudentId = publication?.studentId;
  const recoveredFeedbackKey = `spatia-review-feedback:${actorId}:${projectId}`;
  useEffect(() => {
    if (!publicationStudentId || !educator) return;
    let disposed = false;
    void (async () => {
      try {
        const pending = readApprovalPublication(
          localStorage,
          actorId,
          projectId,
          publicationStudentId,
        );
        if (pending && !disposed) {
          setPendingPublication(pending);
          setFeedback(pending.feedback);
          setPhase("unknown");
        } else if (!pending) {
          const raw = localStorage.getItem(recoveredFeedbackKey);
          if (raw) {
            const recovered: unknown = JSON.parse(raw);
            if (
              typeof recovered === "object" &&
              recovered !== null &&
              "studentId" in recovered &&
              recovered.studentId === publicationStudentId &&
              "feedback" in recovered &&
              typeof recovered.feedback === "string" &&
              recovered.feedback.length <= 4000 &&
              !recovered.feedback.includes("\0") &&
              !disposed
            )
              setFeedback(recovered.feedback);
          }
        }
        const [project, summaries, history] = await Promise.all([
          submissionClient.project(projectId),
          allPages((cursor) => submissionClient.submissions(projectId, cursor)),
          loadStudentFeedback(submissionClient, projectId, publicationStudentId),
        ]);
        const identity = await accounts.getSession();
        if (
          !identity ||
          identity.userId !== actorId ||
          identity.orgId !== orgId ||
          identity.role !== "Educator" ||
          identity.mustChangePassword
        )
          throw new Error("Your account changed. Reload before continuing.");
        const current = summaries.find(
          (item) => item.isCurrentSubmission && item.revision === project.revision,
        );
        const review = current
          ? await submissionClient.getReview(projectId, current.submissionId)
          : null;
        if (review && review.studentId !== publicationStudentId)
          throw new Error("The submission does not match this student.");
        const latest = await accounts.getSession();
        if (
          !latest ||
          latest.userId !== actorId ||
          latest.orgId !== orgId ||
          latest.role !== "Educator" ||
          latest.mustChangePassword
        )
          throw new Error("Your account changed. Reload before continuing.");
        if (disposed) return;
        setSubmissionFeedback(history);
        // Approval follows review authority even when publishing is unavailable
        setCanApprove(
          project.revision === revision &&
            Boolean(review && mayDecide(review, project, "approved")),
        );
        if (
          project.revision === revision &&
          review &&
          (mayDecide(review, project, "approved") ||
            (project.permissions.canManage && reviewState(review, project.revision) === "approved"))
        ) {
          setSubmission({ id: review.submissionId, revision: project.revision });
        }
      } catch (failure) {
        if (!disposed)
          setPublicationError(
            failure instanceof Error ? failure.message : "The submission could not be checked.",
          );
      } finally {
        if (!disposed) setPublicationLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    publicationStudentId,
    educator,
    actorId,
    orgId,
    projectId,
    revision,
    publicationAttempt,
    recoveredFeedbackKey,
  ]);
  const load = useCallback(
    async (after?: string | null) => {
      const version = generation.current;
      setLoading(true);
      setHistoryError("");
      try {
        const page = await client.list(
          projectId,
          actorId,
          educator ? "Educator" : "Creator",
          after,
        );
        if (!active.current || generation.current !== version) return;
        setItems((previous) =>
          after
            ? [
                ...previous,
                ...page.items.filter((item) => !previous.some((old) => old.id === item.id)),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      } catch (failure) {
        if (active.current && generation.current === version) {
          setItems([]);
          setCursor(null);
          setHistoryError(
            failure instanceof Error ? failure.message : "Reviews could not be loaded.",
          );
        }
      } finally {
        if (active.current && generation.current === version) setLoading(false);
      }
    },
    [projectId, actorId, educator],
  );
  useEffect(() => {
    active.current = true;
    const generations = generation;
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) void load();
    });
    return () => {
      disposed = true;
      active.current = false;
      generations.current++;
    };
  }, [load]);
  useEffect(() => {
    onGuard({
      pending: phase === "sending" || (phase === "unknown" && !pendingPublication),
      dirty: !!feedback && !pendingPublication,
    });
  }, [onGuard, phase, feedback, pendingPublication]);
  useEffect(() => {
    if (!feedback && phase === "ready") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [feedback, phase]);
  function close() {
    if (phase === "sending" || (phase === "unknown" && !pendingPublication)) return;
    if (pendingPublication) {
      setOpen(false);
      onClose?.();
      return;
    }
    if (feedback && !window.confirm("Discard your unsaved progress review?")) return;
    try {
      localStorage.removeItem(recoveredFeedbackKey);
    } catch {
      /* Keep recoverable text. */
    }
    setFeedback("");
    setEditing(false);
    setOpen(false);
    onClose?.();
    setError("");
    setConflict(false);
  }
  async function save(retry = false) {
    if (
      busy.current ||
      (retry ? phase !== "unknown" || !intent : phase !== "ready" || !feedback.trim())
    )
      return;
    const sent = retry
      ? intent!
      : { reviewId: crypto.randomUUID(), expectedRevision: revision, feedback };
    setIntent(sent);
    busy.current = true;
    setPhase("sending");
    setError("");
    const result = await client.save(projectId, actorId, sent);
    if (!active.current) return;
    busy.current = false;
    if (result.kind === "confirmed") {
      try {
        localStorage.removeItem(recoveredFeedbackKey);
      } catch {
        /* Keep recoverable text. */
      }
      setItems((previous) => [
        ...previous.filter((item) => item.id !== result.item.id),
        result.item,
      ]);
      setFeedback("");
      setIntent(null);
      setEditing(false);
      setPhase("ready");
      onSaved?.();
    } else if (result.kind === "rejected" && !retry) {
      setPhase("ready");
      setIntent(null);
      if ([401, 403, 404].includes(result.error.status)) {
        setItems([]);
        setCursor(null);
        setHistoryError(result.error.message);
      } else if (result.error.status === 409) {
        setConflict(true);
        setError(
          result.error.message + " Copy your text, then close this dialog and refresh the project.",
        );
      } else {
        setError(result.error.message);
      }
    } else {
      setPhase("unknown");
      setError(
        "The review could not be confirmed. Your text is preserved. Retry the same request before leaving.",
      );
    }
  }
  async function publish(retry = false) {
    if (busy.current || (!retry && (!canApprove || phase !== "ready"))) return;
    if (!navigator.locks) {
      setError(
        "This browser cannot safely coordinate review requests. Please use a supported browser.",
      );
      return;
    }
    const sent = retry
      ? pendingPublication
      : publicationStudentId && {
          projectId,
          actorId,
          studentId: publicationStudentId,
          submissionId: submission?.id ?? null,
          decisionId: crypto.randomUUID(),
          publicationId: crypto.randomUUID(),
          revision,
          feedback,
          approvalOnly: true as const,
        };
    if (!sent) return;
    busy.current = true;
    setPhase("sending");
    setError("");
    try {
      const result = await navigator.locks.request(
        `spatia-review-publication:${actorId}:${projectId}`,
        () => {
          const bound = <T,>(action: () => Promise<T>) =>
            withPublicationSession(
              { userId: actorId, orgId: orgId ?? null },
              accounts.getSession,
              action,
            );
          return approveAndPublish(
            localStorage,
            sent,
            (...args) => bound(() => submissionClient.execute(...args)),
            (...args) => bound(() => workspace.write(...args)),
            retry,
          );
        },
      );
      if (!active.current) return;
      if (result.kind === "approved") {
        // Refresh the current decision after approval
        try {
          localStorage.removeItem(recoveredFeedbackKey);
        } catch {
          /* Keep recoverable text */
        }
        setPendingPublication(null);
        setFeedback("");
        setCanApprove(false);
        setApprovalSaved(true);
        setPublicationLoading(true);
        setPublicationAttempt((value) => value + 1);
        setPhase("ready");
        onSaved?.();
      } else if (result.kind === "published") {
        try {
          localStorage.removeItem(recoveredFeedbackKey);
        } catch {
          /* Keep recoverable text. */
        }
        setPendingPublication(null);
        setFeedback("");
        setPublishedUrl(result.acknowledgement.visitorUrl);
        setPhase("ready");
      } else if (result.kind === "pending") {
        setPendingPublication(sent);
        setPhase("unknown");
        setError(result.message);
      } else if (result.kind === "revision-conflict" || result.kind === "publication-rejected") {
        setPendingPublication(null);
        setSubmission(null);
        setCanApprove(false);
        setFeedback("");
        if (result.kind === "revision-conflict") {
          setConflict(true);
        } else {
          setPublicationLoading(true);
          setPublicationAttempt((value) => value + 1);
        }
        setPhase("ready");
        setError(result.message);
      } else {
        setPhase("ready");
        setError(result.message);
      }
    } catch {
      if (active.current) {
        setPendingPublication(sent);
        setPhase("unknown");
        setError("The result could not be confirmed. Retry the same request.");
      }
    } finally {
      busy.current = false;
    }
  }
  async function checkEarlierPublication() {
    if (!pendingPublication || pendingPublication.submissionId !== null || busy.current) return;
    busy.current = true;
    setLegacyChecked(false);
    setLegacyUnverified(false);
    setLegacyAcknowledged(false);
    setLegacyMessage("");
    try {
      const value = await withPublicationSession(
        { userId: actorId, orgId: orgId ?? null },
        accounts.getSession,
        () =>
          workspace.read(
            `/api/v1/publications/${encodeURIComponent(pendingPublication.publicationId)}/access`,
          ),
      );
      const checked = publicationAccessState(value, projectId, pendingPublication.publicationId);
      if (!checked) throw new Error("Unverified publication");
      setLegacyChecked(true);
      setLegacyMessage(
        `The earlier publication exists. Audience: ${checked.audience}. Access is ${checked.revoked ? "revoked" : checked.deleted ? "deleted" : checked.hidden ? "hidden" : checked.archived ? "archived" : "active"}. Review its access before continuing.`,
      );
    } catch {
      setLegacyUnverified(true);
      setLegacyMessage(
        "The earlier publication could not be verified. It may still exist; check access or contact an administrator before continuing.",
      );
    } finally {
      busy.current = false;
    }
  }
  async function acknowledgeEarlierPublication(abandon = false) {
    if (
      !(legacyChecked || (abandon && legacyUnverified && legacyAcknowledged)) ||
      !pendingPublication ||
      pendingPublication.submissionId !== null ||
      busy.current
    )
      return;
    if (!navigator.locks) {
      setLegacyMessage(
        "This browser cannot safely coordinate the earlier request. Use a supported browser.",
      );
      return;
    }
    busy.current = true;
    try {
      await navigator.locks.request(
        `spatia-review-publication:${actorId}:${projectId}`,
        async () => {
          const cleared = await withPublicationSession(
            { userId: actorId, orgId: orgId ?? null },
            accounts.getSession,
            async () => {
              const current = readApprovalPublication(
                localStorage,
                actorId,
                projectId,
                pendingPublication.studentId,
              );
              if (JSON.stringify(current) !== JSON.stringify(pendingPublication))
                throw new Error("Request changed");
              const recovered = JSON.stringify({
                studentId: pendingPublication.studentId,
                feedback: pendingPublication.feedback,
              });
              const earlierFeedback = localStorage.getItem(recoveredFeedbackKey);
              if (earlierFeedback !== null && earlierFeedback !== recovered)
                throw new Error("Existing recovered feedback");
              localStorage.setItem(recoveredFeedbackKey, recovered);
              if (localStorage.getItem(recoveredFeedbackKey) !== recovered)
                throw new Error("Storage failed");
              localStorage.removeItem(`spatia-review-publication:${actorId}:${projectId}`);
              if (
                localStorage.getItem(`spatia-review-publication:${actorId}:${projectId}`) !== null
              )
                throw new Error("Storage failed");
              return true;
            },
          );
          if (cleared !== true) throw new Error("Session or storage changed");
        },
      );
      setPendingPublication(null);
      setPhase("ready");
      setLegacyChecked(false);
      setLegacyMessage("Earlier publication acknowledged. Your review text is preserved.");
    } catch {
      setLegacyMessage(
        "The earlier request could not be safely cleared. Reload and check it again.",
      );
    } finally {
      busy.current = false;
    }
  }
  const history = (
    <>
      {loading && <p role="status">Loading reviews…</p>}
      {decisionsLoading && <p role="status">Loading submission feedback…</p>}
      {decisionsError && <p role="alert">{decisionsError}</p>}
      {historyError && <p role="alert">{historyError}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading &&
        !historyError &&
        !error &&
        !decisionsLoading &&
        !decisionsError &&
        items.length === 0 &&
        (publication ? submissionFeedback.length : decisions.length) === 0 && (
          <p>No reviews yet.</p>
        )}
      <ProgressReviewList items={items} decisions={publication ? submissionFeedback : decisions} />
      {cursor && (
        <Button disabled={loading || phase !== "ready"} onClick={() => void load(cursor)}>
          Load more reviews
        </Button>
      )}
      {historyError && phase === "ready" && (
        <Button onClick={() => void load()}>Retry loading reviews</Button>
      )}
    </>
  );
  if (!educator)
    return (
      <section className="sp-card sp-reviews" aria-label="Reviews">
        <h3>Reviews</h3>
        {history}
      </section>
    );
  return (
    <>
      {!autoOpen && <Button onClick={() => setOpen(true)}>Reviews</Button>}
      {open && (
        <Dialog
          title={publication ? "Review submission" : "Reviews"}
          variant="progress"
          onClose={close}
        >
          {publication && (
            <>
              <h3>{publication.projectTitle}</h3>
              <p>{publication.studentName}</p>
            </>
          )}
          {history}
          {pendingPublication?.submissionId === null && (
            <section aria-label="Earlier publishing request">
              <p>
                An earlier publishing request has an uncertain outcome. Publication ID:{" "}
                {pendingPublication.publicationId}. Check it before starting another request.
              </p>
              <Button onClick={() => void checkEarlierPublication()}>
                Check earlier publication
              </Button>
              {legacyMessage && <p role="status">{legacyMessage}</p>}
              {legacyChecked && (
                <Button onClick={() => void acknowledgeEarlierPublication()}>
                  Acknowledge publication
                </Button>
              )}
              {legacyUnverified && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={legacyAcknowledged}
                      onChange={(event) => setLegacyAcknowledged(event.target.checked)}
                    />
                    I understand the earlier publication may still exist, and I will check its
                    access before publishing again.
                  </label>
                  <Button
                    disabled={!legacyAcknowledged}
                    onClick={() => void acknowledgeEarlierPublication(true)}
                  >
                    Stop tracking earlier request
                  </Button>
                </>
              )}
            </section>
          )}
          {publicationError && (
            <div>
              <p role="alert">{publicationError}</p>
              <Button
                disabled={publicationLoading}
                onClick={() => {
                  setPublicationLoading(true);
                  setPublicationError("");
                  setSubmission(null);
                  setCanApprove(false);
                  setPublicationAttempt((value) => value + 1);
                }}
              >
                Retry submission check
              </Button>
            </div>
          )}
          {editing ? (
            <div className="sp-progress-draft">
              <time>
                {new Date().toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </time>
              <label htmlFor="progress-feedback">
                {publication ? "Your review" : "New review"}
              </label>
              <textarea
                id="progress-feedback"
                rows={3}
                maxLength={4000}
                value={feedback}
                disabled={phase !== "ready" || Boolean(publishedUrl)}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>
          ) : (
            <Button className="sp-progress-add" variant="primary" onClick={() => setEditing(true)}>
              + Add Reviews
            </Button>
          )}
          <div className="sp-actions sp-progress-actions">
            {publishedUrl ? (
              <Button variant="primary" onClick={() => (onSaved ? onSaved() : close())}>
                Done
              </Button>
            ) : phase === "unknown" && pendingPublication?.submissionId === null ? (
              <Button onClick={close}>Close, keep request</Button>
            ) : phase === "unknown" ? (
              <>
                <Button onClick={close} disabled={!pendingPublication}>
                  Close, keep request
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void (pendingPublication ? publish(true) : save(true))}
                >
                  Retry same request
                </Button>
              </>
            ) : (
              <>
                <Button disabled={phase !== "ready"} onClick={close}>
                  Cancel
                </Button>
                <Button
                  variant={editing && feedback.trim() ? "primary" : "secondary"}
                  disabled={
                    phase !== "ready" || conflict || !feedback.trim() || feedback.includes("\0")
                  }
                  onClick={() => void save()}
                >
                  {publication ? "Save review" : "Save Changes"}
                </Button>
                {publication && !publishedUrl && (
                  <Button
                    variant="primary"
                    disabled={
                      phase !== "ready" ||
                      publicationLoading ||
                      !canApprove ||
                      feedback.includes("\0")
                    }
                    onClick={() => void publish()}
                  >
                    Approve
                  </Button>
                )}
              </>
            )}
          </div>
          {publication &&
            !canApprove &&
            !approvalSaved &&
            !pendingPublication &&
            !publishedUrl &&
            !publicationError &&
            !publicationLoading && (
              <p>Approval requires permission and a current submission ready for review.</p>
            )}
          {publication && <p>After approval, the student can publish the approved revision.</p>}
          {approvalSaved && !publishedUrl && (
            <p role="status">Approval saved. The student can now publish the approved revision.</p>
          )}
          {publishedUrl && <PublicationShare url={publishedUrl} unlisted />}
        </Dialog>
      )}
    </>
  );
}
