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
