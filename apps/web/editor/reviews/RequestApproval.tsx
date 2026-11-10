import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { useModal } from "../../shared/ui/useModal";
import { createAccountClient } from "../accounts/account-client";
import { allPages, createReviewClient } from "./review-client";
import { PublishStatus } from "../publications/PublishStatus";
import type { ReviewIntent } from "./review-types";
import "./request-approval.css";

const accounts = createAccountClient();
const reviews = createReviewClient();

async function checkAccount(actorId: string) {
  const identity = await accounts.getSession();
  if (identity?.userId !== actorId || identity.mustChangePassword || identity.role !== "Creator")
    throw new Error("Your account changed. Reopen the project before submitting.");
}

export function RequestApproval({
  projectId,
  actorId,
  save,
  isSaved,
  onClose,
  onSubmitted,
}: {
  projectId: string;
  actorId: string;
  save?: () => Promise<void>;
  isSaved?: (revision: number) => boolean;
  onClose: () => void;
  onSubmitted: (revision: number, approved?: boolean) => void;
}) {
  const dialog = useModal(true);
  const session = useRef({ save, isSaved, onSubmitted });
  const [revision, setRevision] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "sending" | "unknown">("loading");
  const intent = useRef<ReviewIntent | null>(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  const locked = phase === "loading" || phase === "sending" || phase === "unknown";

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const { save, isSaved, onSubmitted } = session.current;
    void (async () => {
      try {
        // Save first without disposing the editing session or submitting an older revision
        await save?.();
        await checkAccount(actorId);
        const [project, submissions] = await Promise.all([
          reviews.project(projectId),
          allPages((cursor) => reviews.submissions(projectId, cursor)),
        ]);
        if (!project.permissions.canEdit || (isSaved && !isSaved(project.revision)))
          throw new Error(
            "Your latest changes are not saved yet. Close this dialog and retry after saving.",
          );
        const latest = submissions.sort((a, b) => b.sequence - a.sequence)[0];
        const review = latest ? await reviews.getReview(projectId, latest.submissionId) : null;
        await checkAccount(actorId);
        if (cancelled) return;
        if (
          review?.isCurrentSubmission &&
          review.revision === project.revision &&
          (!review.latestDecision || review.latestDecision.outcome === "approved")
        ) {
          setWaiting(true);
          setRevision(project.revision);
          onSubmitted(project.revision, review.latestDecision?.outcome === "approved");
          return;
        }
        setRevision(project.revision);
      } catch (failure) {
        if (!cancelled)
          setError(
            failure instanceof Error
              ? failure.message
              : "Submission could not be prepared. Try again.",
          );
      } finally {
        if (!cancelled) setPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [actorId, projectId]);

  useEffect(() => {
    if (phase !== "sending" && phase !== "unknown") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  async function submit(retry = false) {
    if (
      sending.current ||
      revision === null ||
      (retry ? phase !== "unknown" : phase !== "ready" || waiting)
    )
      return;
    sending.current = true;
    setPhase("sending");
    setError("");
    try {
      await checkAccount(actorId);
      if (!retry && isSaved && !isSaved(revision))
        throw new Error(
          "Your project changed. Close this dialog and review the latest saved revision.",
        );
      // Reuse the same submission ID after a lost response so retry cannot create another submission
      intent.current ??= {
        kind: "submit",
        projectId,
        submissionId: crypto.randomUUID(),
        expectedRevision: revision,
        completionConfirmed: true,
      };
      const result = await reviews.execute(intent.current, actorId);
      if (!mounted.current) return;
      if (result.kind === "confirmed") {
        setWaiting(true);
        setPhase("ready");
        onSubmitted(revision);
      } else if (result.kind === "unknown" || retry) {
        setPhase("unknown");
        setError(
          result.kind === "rejected"
            ? result.error.message + " The original outcome is still unconfirmed."
            : "We could not confirm submission. Check its status or retry the same request.",
        );
      } else {
        intent.current = null;
        setPhase("ready");
        setRevision(null);
        setError(
          result.error.message + " Close this dialog and reopen it to refresh the saved revision.",
        );
      }
    } catch (failure) {
      if (mounted.current) {
        setPhase(retry ? "unknown" : "ready");
        setError(failure instanceof Error ? failure.message : "Submission could not be confirmed.");
      }
    } finally {
      sending.current = false;
    }
  }

  async function checkOutcome() {
    if (!intent.current || sending.current) return;
    sending.current = true;
    setPhase("sending");
    try {
      await checkAccount(actorId);
      const found = await reviews.reconcile(intent.current);
      if (!mounted.current) return;
      if (found) {
        setWaiting(true);
        setPhase("ready");
        onSubmitted(intent.current.expectedRevision);
      } else {
        setPhase("unknown");
        setError("Submission is not confirmed yet. Retry the same request.");
      }
    } catch (failure) {
      if (mounted.current) {
        setPhase("unknown");
        setError(
          failure instanceof Error ? failure.message : "Submission status could not be checked.",
        );
      }
    } finally {
      sending.current = false;
    }
  }

  return (
    <dialog
      ref={dialog}
      className="creator-approval-dialog"
      data-loading={phase === "loading"}
      aria-busy={phase === "loading"}
      aria-labelledby="creator-approval-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!locked) onClose();
      }}
    >
      <PublishStatus
        state={
          phase === "loading" || (revision === null && !waiting)
            ? "checking"
            : waiting
              ? "pending"
              : "incomplete"
        }
        titleId="creator-approval-title"
        onClose={onClose}
        closeLabel="Close request approval"
        locked={locked}
        actions={
          waiting ? (
            <Button variant="primary" onClick={onClose}>
              Back to Project
            </Button>
          ) : (
            <>
              <Button disabled={locked} onClick={onClose}>
                Cancel
              </Button>
              {phase === "unknown" ? (
                <>
                  <Button onClick={() => void checkOutcome()}>Check status</Button>
                  <Button variant="primary" onClick={() => void submit(true)}>
                    Retry submission
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  disabled={locked || revision === null}
                  onClick={() => void submit()}
                >
                  {phase === "sending" ? "Submitting…" : "Mark as Completed"}
                </Button>
              )}
            </>
          )
        }
      >
        {phase === "loading" && (
          <p role="status" className="publish-status-loading">
            Preparing your saved project…
          </p>
        )}
        {error && (
          <p role="alert" className="creator-approval-error">
            {error}
          </p>
        )}
      </PublishStatus>
    </dialog>
  );
}
