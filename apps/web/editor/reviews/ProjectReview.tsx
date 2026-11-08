import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountRole } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { allPages, ReviewError, type ReviewClient } from "./review-client";
import {
  mayDecide,
  reviewState,
  type Outcome,
  type Review,
  type ReviewIntent,
  type SavedProject,
  type SubmissionSummary,
} from "./review-types";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import { ReviewDocument } from "./ReviewDocument";
import { ProgressReviews } from "./ProgressReviews";

const labels = {
  pending: "Awaiting educator review",
  approved: "Approved for this revision",
  returned: "Returned for changes",
  revoked: "Approval revoked",
  historical: "Historical submission — not approval of the current revision",
};
const actionLabels = {
  approved: "Approve submission",
  returned: "Return with feedback",
  revoked: "Revoke approval",
};
const time = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value).toLocaleString();

export function ProjectReview({
  client,
  projectId,
  studentId,
  studentName,
  className,
  role,
  actorId,
  onGuard,
}: {
  client: ReviewClient;
  projectId: string;
  studentId: string;
  studentName: string;
  className: string;
  role: AccountRole;
  actorId: string;
  onGuard: (guard: LeaveGuard) => void;
}) {
  const [project, setProject] = useState<SavedProject | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionSummary[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [feedback, setFeedback] = useState("");
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState<ReviewIntent | null>(null);
  const [phase, setPhase] = useState<"ready" | "confirm" | "sending" | "unknown">("ready");
  const [historyError, setHistoryError] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [progressGuard, setProgressGuard] = useState<LeaveGuard>({ pending: false, dirty: false });
  const generation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLElement>(null);

  const load = useCallback(
    async (preferredId?: string) => {
      const version = ++generation.current;
      setLoading(true);
      setComplete(false);
      setError("");
      setHistoryError("");
      try {
        const [saved, summaries] = await Promise.all([
          client.project(projectId),
          allPages((cursor) => client.submissions(projectId, cursor)),
        ]);
        summaries.sort((a, b) => b.sequence - a.sequence);
        const selected =
          (preferredId && summaries.find((s) => s.submissionId === preferredId)) || summaries[0];
        const detail = selected ? await client.getReview(projectId, selected.submissionId) : null;
        if (detail && detail.studentId !== studentId)
          throw new ReviewError("The selected submission does not match this student.");
        if (!mounted.current || generation.current !== version) return;
        setProject(saved);
        setSubmissions(summaries);
        setReview(detail);
      } catch (failure) {
        if (!mounted.current || generation.current !== version) return;
        // Never keep private content/actions visible after access is lost or a refresh fails.
        setProject(null);
        setSubmissions([]);
        setReview(null);
        setError(
          failure instanceof Error ? failure.message : "The submission could not be loaded.",
        );
      } finally {
        if (mounted.current && generation.current === version) setLoading(false);
      }
    },
    [client, projectId, studentId],
  );

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const requests = generation;
    void Promise.resolve().then(() => {
      if (!disposed) void load();
    });
    return () => {
      disposed = true;
      mounted.current = false;
      requests.current++;
    };
  }, [load]);
  const locked = phase === "sending" || phase === "unknown" || progressGuard.pending;
  const dirty = !!feedback || complete || phase === "confirm" || progressGuard.dirty;
  useEffect(() => {
    onGuard({ pending: locked, dirty });
  }, [onGuard, locked, dirty]);
  useEffect(() => {
    if (!dirty && !locked) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, locked]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (notice) statusRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    if (phase === "confirm") confirmRef.current?.focus();
  }, [phase]);

  const state = project && review ? reviewState(review, project.revision) : null;
  const current =
    project && submissions.find((s) => s.isCurrentSubmission && s.revision === project.revision);
  const canSubmit =
    role === "Creator" && project?.permissions.canEdit && !loading && phase === "ready" && complete;
  const feedbackValid = !!feedback.trim() && feedback.length <= 4000 && !feedback.includes("\0");
  function prepare(outcome?: Outcome) {
    if (!project || busy.current || loading || phase !== "ready") return;
    if (!outcome) {
      if (!canSubmit) return;
      setIntent({
        kind: "submit",
        projectId,
        submissionId: crypto.randomUUID(),
        expectedRevision: project.revision,
        completionConfirmed: true,
      });
    } else {
      if (role !== "Educator" || !review || !feedbackValid || !mayDecide(review, project, outcome))
        return;
      setIntent({
        kind: "decide",
        projectId,
        submissionId: review.submissionId,
        decisionId: crypto.randomUUID(),
        expectedRevision: project.revision,
        outcome,
        feedback,
      });
    }
    setError("");
    setNotice("");
    setPhase("confirm");
  }
  async function confirmed(sent: ReviewIntent) {
    setIntent(null);
    setPhase("ready");
    setComplete(false);
    setFeedback("");
    setNotice(sent.kind === "submit" ? "Submission confirmed." : "Decision saved.");
    await load(sent.submissionId);
  }
  async function sendIntent(retry = false) {
    if (!intent || busy.current || (retry ? phase !== "unknown" : phase !== "confirm")) return;
    const sent = intent;
    busy.current = true;
    setPhase("sending");
    setError("");
    setNotice("");
    const result = await client.execute(sent, actorId);
    if (!mounted.current) return;
    busy.current = false;
    if (result.kind === "confirmed") {
      await confirmed(sent);
    } else if (result.kind === "rejected") {
      // After a lost response, even a denial of a retry does not prove the original failed.
      if (retry) {
        setPhase("unknown");
        setError(result.error.message + " The original outcome is still unconfirmed.");
      } else {
        setPhase("ready");
        setIntent(null);
        // Read the current authoritative revision before permitting a fresh action.
        await load(sent.submissionId);
        if (mounted.current) setError(result.error.message);
      }
    } else {
      setPhase("unknown");
      setError(
        "The outcome is not confirmed. Your input is preserved. Check the outcome or retry the same request before starting another action.",
      );
    }
  }
  async function reconcile() {
    if (!intent || busy.current || phase !== "unknown") return;
    const sent = intent;
    busy.current = true;
    setPhase("sending");
    setError("");
    try {
      const found = await client.reconcile(sent);
      if (!mounted.current) return;
      if (found) await confirmed(sent);
      else {
        setPhase("unknown");
        setError(
          "No matching decision was found. You can retry the same request; this does not create a new request.",
        );
      }
    } catch (failure) {
      if (!mounted.current) return;
      setPhase("unknown");
      setError(
        (failure instanceof Error ? failure.message : "The outcome could not be checked.") +
          " The original outcome remains unconfirmed.",
      );
    } finally {
      busy.current = false;
    }
  }
  async function moreDecisions() {
    if (!review?.nextCursor || historyBusy || locked) return;
    const selected = review;
    const version = generation.current;
    setHistoryBusy(true);
    setHistoryError("");
    try {
      const next = await client.getReview(projectId, selected.submissionId, selected.nextCursor);
      if (mounted.current && version === generation.current)
        setReview({
          ...next,
          decisions: [
            ...selected.decisions,
            ...next.decisions.filter((d) => !selected.decisions.some((old) => old.id === d.id)),
          ],
        });
    } catch (failure) {
      if (mounted.current && version === generation.current) {
        if (failure instanceof ReviewError && [401, 403, 404].includes(failure.status)) {
          setProject(null);
          setReview(null);
          setSubmissions([]);
          setError(failure.message);
        } else {
          setHistoryError(
            failure instanceof Error ? failure.message : "History could not be loaded.",
          );
        }
      }
    } finally {
      if (mounted.current) setHistoryBusy(false);
    }
  }
  return (
    <section className="sp-reviews" aria-busy={loading || phase === "sending"}>
      <div className="sp-review-heading">
        <h2>
          {studentName} · {className}
        </h2>
        <Button
          disabled={loading || locked || phase === "confirm" || progressGuard.dirty}
          onClick={() => {
            setComplete(false);
            void load(review?.submissionId);
          }}
        >
          Refresh status
        </Button>
      </div>
      {loading && <p role="status">Loading saved project and review…</p>}
      {notice && (
        <p role="status" tabIndex={-1} ref={statusRef}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      {!project && feedback && (
        <Field
          id="preserved-review-feedback"
          label="Preserved feedback"
          hint="Your unsaved feedback is still here. Copy it before leaving if access cannot be restored."
        >
          <textarea id="preserved-review-feedback" rows={5} readOnly value={feedback} />
        </Field>
      )}
      {project && (
        <>
          <h3>{project.document.title}</h3>
          <p>
            Current server-saved revision: <strong>{project.revision}</strong>
          </p>
          <p className="sp-hint">
            This screen uses work saved on the server. Changes in an open editor or downloaded file
            are not submitted by this screen.
          </p>
          <ProgressReviews
            key={`${projectId}:${actorId}:${role}`}
            projectId={projectId}
            revision={project.revision}
            actorId={actorId}
            educator={role === "Educator"}
            onGuard={setProgressGuard}
          />
          {submissions.length > 0 && (
            <Field id="review-history" label="Submission">
              <select
                id="review-history"
                value={review?.submissionId ?? ""}
                disabled={loading || locked || phase === "confirm" || progressGuard.dirty}
                onChange={(e) => {
                  if (
                    feedback &&
                    !window.confirm(
                      "Discard your unsaved feedback before choosing another submission?",
                    )
                  )
                    return;
                  setFeedback("");
                  setComplete(false);
                  void load(e.target.value);
                }}
              >
                {submissions.map((s) => (
                  <option key={s.submissionId} value={s.submissionId}>
                    Submission {s.sequence} · Revision {s.revision}
                    {s.isCurrentSubmission && s.revision === project.revision
                      ? " · Current"
                      : " · Historical"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {review ? (
            <>
              <p className="sp-badge">{state ? labels[state] : ""}</p>
              <p>
                Submitted {time(review.submittedAt)} · Due {time(review.dueAtUnixSeconds)} ·{" "}
                <strong>{review.isLate ? "Late submission" : "On time"}</strong>
              </p>
              {state === "historical" && (
                <p>
                  A new or newer submission must be reviewed. Approval here does not apply to the
                  current work.
                </p>
              )}
              {review.latestDecision && (
                <section className="sp-card sp-reviews" aria-label="Educator feedback">
                  <h3>Latest educator feedback</h3>
                  <p className="sp-review-feedback">
                    {review.latestDecision.feedback || "No feedback was recorded."}
                  </p>
                  <p className="sp-hint">
                    {review.latestDecision.outcome} · {time(review.latestDecision.decidedAt)}
                  </p>
                </section>
              )}
              <ReviewDocument document={review.document} revision={review.revision} submitted />
              <details>
                <summary>Decision history</summary>
                {review.decisions.length === 0 && <p>No decisions have been recorded.</p>}
                {[...review.decisions]
                  .sort((a, b) => b.sequence - a.sequence)
                  .map((d) => (
                    <article key={d.id}>
                      <p>
                        <strong>{d.outcome}</strong> · {time(d.decidedAt)}
                      </p>
                      <p className="sp-review-feedback">{d.feedback || "No feedback recorded."}</p>
                    </article>
                  ))}
                {historyError && <p role="alert">{historyError}</p>}
                {review.nextCursor && (
                  <Button disabled={historyBusy || locked} onClick={() => void moreDecisions()}>
                    Load more decisions
                  </Button>
                )}
              </details>
            </>
          ) : (
            <>
              <p>No submissions have been made for this project.</p>
              <ReviewDocument
                document={project.document}
                revision={project.revision}
                submitted={false}
              />
            </>
          )}
          {role === "Creator" && (
            <section className="sp-card sp-reviews" aria-label="Submit saved work">
              <h3>{current ? "Submit this saved revision again" : "Submit saved work"}</h3>
              {current && (
                <p>
                  A new submission replaces the previous submission for review. It needs a new
                  educator decision, even if the revision has not changed.
                </p>
              )}
              {review && review.revision !== project.revision && (
                <ReviewDocument
                  document={project.document}
                  revision={project.revision}
                  submitted={false}
                />
              )}
              <label>
                <input
                  type="checkbox"
                  checked={complete}
                  disabled={loading || phase !== "ready" || !project.permissions.canEdit}
                  onChange={(e) => setComplete(e.target.checked)}
                />{" "}
                I have checked server-saved revision {project.revision} and confirm it is complete.
              </label>
              <p className="sp-hint">
                You may submit after the deadline; the submission will be marked late.
              </p>
              <Button variant="primary" disabled={!canSubmit} onClick={() => prepare()}>
                Submit for review
              </Button>
              {!project.permissions.canEdit && (
                <p>You cannot submit this project with your current access.</p>
              )}
            </section>
          )}
          {role === "Educator" && review && (
            <section className="sp-card sp-reviews" aria-label="Review decision">
              <Field
                id="review-feedback"
                label="Feedback"
                required
                hint="Feedback is saved with an explicit decision. Maximum 4,000 characters."
              >
                <textarea
                  id="review-feedback"
                  aria-describedby="review-feedback-hint"
                  rows={5}
                  value={feedback}
                  maxLength={4000}
                  disabled={loading || phase !== "ready"}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              </Field>
              <div className="sp-actions">
                {(["approved", "returned", "revoked"] as const).map((outcome) => (
                  <Button
                    key={outcome}
                    disabled={
                      loading ||
                      phase !== "ready" ||
                      !feedbackValid ||
                      !mayDecide(review, project, outcome)
                    }
                    onClick={() => prepare(outcome)}
                  >
                    {actionLabels[outcome]}
                  </Button>
                ))}
                <Button
                  disabled={phase !== "ready" || !feedback}
                  onClick={() => {
                    if (window.confirm("Discard this unsaved feedback?")) setFeedback("");
                  }}
                >
                  Discard feedback
                </Button>
              </div>
              {state === "returned" || state === "revoked" ? (
                <p>The student must submit again before another decision.</p>
              ) : null}
            </section>
          )}
          <section className="sp-card sp-reviews" aria-label="Publication prerequisites">
            <h3>Publication</h3>
            <p>
              Current revision approval:{" "}
              {state === "approved" ? "confirmed" : "not confirmed for the selected submission"}.
            </p>
            <p>
              Publish permission:{" "}
              {project.permissions.canPublish
                ? "allowed by current project permissions"
                : "not granted"}
              .
            </p>
            {state === "approved" &&
            project.permissions.canPublish &&
            !loading &&
            phase === "ready" &&
            !dirty ? (
              <a
                className="sp-button sp-button--primary"
                href={`/publish?projectId=${encodeURIComponent(projectId)}`}
              >
                Publish project
              </a>
            ) : (
              <Button disabled>Publish project</Button>
            )}
            <p className="sp-hint">
              {loading || phase !== "ready"
                ? "Wait for the current review action to finish before publishing."
                : dirty
                  ? "Save or discard your unsaved input before publishing."
                  : state !== "approved"
                    ? "The current submission must be approved before publishing."
                    : !project.permissions.canPublish
                      ? "Your current project access does not allow publishing."
                      : "Continue to publishing to choose how to share this project."}
            </p>
          </section>
        </>
      )}
      {phase === "confirm" && intent && (
        <section
          role="region"
          aria-label="Confirm action"
          className="sp-card sp-reviews"
          ref={confirmRef}
          tabIndex={-1}
        >
          <h3>{intent.kind === "submit" ? "Confirm submission" : actionLabels[intent.outcome]}</h3>
          <p>
            {intent.kind === "submit" ? "Submit" : "Record this decision for"} {studentName}’s saved
            revision {intent.expectedRevision}?
          </p>
          {intent.kind === "decide" && <p className="sp-review-feedback">{intent.feedback}</p>}
          <div className="sp-actions">
            <Button variant="primary" onClick={() => void sendIntent()}>
              Confirm {intent.kind === "submit" ? "submission" : "decision"}
            </Button>
            <Button
              onClick={() => {
                setIntent(null);
                setPhase("ready");
              }}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}
      {phase === "sending" && (
        <p role="status">Checking the request… Please wait before leaving this screen.</p>
      )}
      {phase === "unknown" && (
        <div className="sp-actions">
          <Button onClick={() => void reconcile()}>Check outcome</Button>
          <Button onClick={() => void sendIntent(true)}>Retry same request</Button>
        </div>
      )}
    </section>
  );
}
