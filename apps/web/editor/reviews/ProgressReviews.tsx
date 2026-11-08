import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import {
  createProgressReviewClient,
  type ProgressIntent,
  type ProgressReview,
} from "./progress-review-client";
import type { LeaveGuard } from "./ReviewWorkspace";
import { allPages, createReviewClient } from "./review-client";
import { mayDecide, reviewState, type Decision } from "./review-types";
import { loadStudentFeedback } from "../home/student-feedback";
import { createWorkspaceClient } from "../home/workspace-api";
import { createAccountClient } from "../accounts/account-client";
import { PublicationShare } from "../publications/PublicationShare";
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
  educator,
  onGuard,
  autoOpen = false,
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
  educator: boolean;
  onGuard: (guard: LeaveGuard) => void;
  autoOpen?: boolean;
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
  const [editing, setEditing] = useState(Boolean(publication));
  const [feedback, setFeedback] = useState("");
  const [intent, setIntent] = useState<ProgressIntent | null>(null);
  const [phase, setPhase] = useState<"ready" | "sending" | "unknown">("ready");
  const [conflict, setConflict] = useState(false);
  const [submission, setSubmission] = useState<{ id: string; revision: number } | null>(null);
  const [submissionFeedback, setSubmissionFeedback] = useState<Decision[]>([]);
  const [publicationLoading, setPublicationLoading] = useState(Boolean(publication));
  const [publicationError, setPublicationError] = useState("");
  const [publicationAttempt, setPublicationAttempt] = useState(0);
  const [pendingPublication, setPendingPublication] = useState<ApprovalPublicationIntent | null>(
    null,
  );
  const [publishedUrl, setPublishedUrl] = useState("");
  const active = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const publicationStudentId = publication?.studentId;
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
          latest.role !== "Educator" ||
          latest.mustChangePassword
        )
          throw new Error("Your account changed. Reload before continuing.");
        if (disposed) return;
        setSubmissionFeedback(history);
        if (
          project.revision === revision &&
          project.permissions.canPublish &&
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
  }, [publicationStudentId, educator, actorId, projectId, revision, publicationAttempt]);
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
      setError(result.error.message);
      if (result.error.status === 409) {
        setConflict(true);
        setError(
          result.error.message + " Copy your text, then close this dialog and refresh the project.",
        );
      }
      if ([401, 403, 404].includes(result.error.status)) {
        setItems([]);
        setCursor(null);
      }
    } else {
      setPhase("unknown");
      setError(
        "The review could not be confirmed. Your text is preserved. Retry the same request before leaving.",
      );
    }
  }
  async function publish(retry = false) {
    if (busy.current || (!retry && (!submission || !feedback.trim() || phase !== "ready"))) return;
    if (!navigator.locks) {
      setError(
        "This browser cannot safely coordinate publishing requests. Please use a supported browser.",
      );
      return;
    }
    const sent = retry
      ? pendingPublication
      : submission &&
        publicationStudentId && {
          projectId,
          actorId,
          studentId: publicationStudentId,
          submissionId: submission.id,
          decisionId: crypto.randomUUID(),
          publicationId: crypto.randomUUID(),
          revision: submission.revision,
          feedback,
        };
    if (!sent) return;
    busy.current = true;
    setPhase("sending");
    setError("");
    try {
      const result = await navigator.locks.request(
        `spatia-review-publication:${actorId}:${projectId}`,
        () =>
          approveAndPublish(localStorage, sent, submissionClient.execute, workspace.write, retry),
      );
      if (!active.current) return;
      if (result.kind === "published") {
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
          {publicationError && (
            <div>
              <p role="alert">{publicationError}</p>
              <Button
                disabled={publicationLoading}
                onClick={() => {
                  setPublicationLoading(true);
                  setPublicationError("");
                  setSubmission(null);
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
                      !submission ||
                      !feedback.trim() ||
                      feedback.includes("\0")
                    }
                    onClick={() => void publish()}
                  >
                    Approve and publish
                  </Button>
                )}
              </>
            )}
          </div>
          {publication &&
            !submission &&
            !pendingPublication &&
            !publishedUrl &&
            !publicationError &&
            !publicationLoading && (
              <p>Publishing requires permission and a submission for the current saved work.</p>
            )}
          {publication && (
            <p>Publishing creates a link anyone can open for this student's project.</p>
          )}
          {publishedUrl && <PublicationShare url={publishedUrl} unlisted />}
        </Dialog>
      )}
    </>
  );
}
