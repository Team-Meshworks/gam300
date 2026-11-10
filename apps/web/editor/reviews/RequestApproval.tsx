import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import close from "@iconify-icons/lucide/x";
import { Button } from "../../shared/ui/Button";
import { useModal } from "../../shared/ui/useModal";
import { createAccountClient } from "../accounts/account-client";
import { allPages, createReviewClient } from "./review-client";
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
  const [complete, setComplete] = useState(false);
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
    if (!complete && phase !== "sending" && phase !== "unknown") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [complete, phase]);

  async function submit(retry = false) {
    if (
      sending.current ||
      revision === null ||
      (retry ? phase !== "unknown" : phase !== "ready" || !complete)
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
      if (found) onSubmitted(intent.current.expectedRevision);
      else {
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
      aria-labelledby="creator-approval-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!locked) onClose();
      }}
    >
      <button
        className="creator-approval-close"
        aria-label="Close request approval"
        disabled={locked}
        onClick={onClose}
      >
        <Icon icon={close} width={20} />
      </button>
      <h2 id="creator-approval-title">Request approval</h2>
      <p>Submit your saved project for your educator to review.</p>
      {phase === "loading" && <p role="status">Preparing your saved project...</p>}
      {revision !== null && (
        <label className="creator-approval-confirm">
          <input
            type="checkbox"
            checked={complete}
            disabled={locked}
            onChange={(event) => setComplete(event.target.checked)}
          />
          <span>I confirm my saved project is complete.</span>
        </label>
      )}
      {error && (
        <p role="alert" className="creator-approval-error">
          {error}
        </p>
      )}
      <div className="creator-approval-actions">
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
            disabled={locked || !complete || revision === null}
            onClick={() => void submit()}
          >
            {phase === "sending" ? "Submitting..." : "Submit for review"}
          </Button>
        )}
      </div>
    </dialog>
  );
}
