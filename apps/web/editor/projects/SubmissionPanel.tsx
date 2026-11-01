import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import {
  canAct,
  confirmsAction,
  type Audience,
  type Submission,
  type SubmissionAction,
  type SubmissionDraft,
  type SubmissionResult,
} from "./submission";
import "./submission.css";

// Mount with a key containing identity + revision; replace after a refreshed snapshot
export function SubmissionPanel({
  submission,
  audience,
  onAction,
  onPreview,
}: {
  submission: Submission;
  audience: Audience;
  onAction?: (draft: SubmissionDraft) => Promise<SubmissionResult>;
  onPreview?: (title: string, body: ReactNode) => void;
}) {
  const [current, setCurrent] = useState(submission);
  const [feedback, setFeedback] = useState("");
  const [phase, setPhase] = useState<"ready" | "pending" | "unknown">("ready");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);
  useEffect(() => {
    if (phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [phase]);
  const enabled = (action: SubmissionAction) =>
    !!onAction && phase === "ready" && canAct(current, action, audience);
  async function act(action: SubmissionAction) {
    if (
      !onAction ||
      busy.current ||
      !enabled(action) ||
      (action === "save-review" && !feedback.trim())
    )
      return;
    busy.current = true;
    setPhase("pending");
    setError("");
    setMessage("");
    const draft = { id: current.id, revision: current.revision, action, feedback };
    let result: SubmissionResult;
    try {
      result = await onAction(draft);
    } catch {
      result = { kind: "unknown" };
    }
    if (!mounted.current) return;
    busy.current = false;
    if (result.kind === "rejected") {
      setPhase("ready");
      setError(result.message);
    } else if (result.kind === "confirmed" && confirmsAction(draft, result.submission)) {
      setCurrent(result.submission);
      setPhase("ready");
      setMessage(
        action === "save-review"
          ? "Review saved."
          : action === "approve"
            ? "Teacher approval confirmed."
            : action === "submit"
              ? "Submission confirmed."
              : "Completion confirmed.",
      );
    } else {
      setPhase("unknown");
      setError(
        "The outcome could not be confirmed. Refresh the submission from its source before trying again. Your feedback is preserved.",
      );
    }
  }
  const titles = {
    editing: "Finish your work first",
    completed: "Send your work for approval",
    submitted: "Your teacher is reviewing your work",
    approved: "Ready to publish your project?",
  };
  return (
    <section className="sp-card sp-submission" aria-busy={phase === "pending"}>
      <h2>{audience === "teacher" ? "Review submission" : titles[current.state]}</h2>
      <h3>{current.title}</h3>
      <p className="sp-hint">
        Class {current.className} · {current.student} · Revision {current.revision}
      </p>
      <p className="sp-badge">
        {
          {
            editing: "Not completed",
            completed: "Completed · Not submitted",
            submitted: "Completed · Awaiting teacher approval",
            approved: "Completed · Teacher-approved",
          }[current.state]
        }
      </p>
      {audience === "teacher" ? (
        <>
          <Field id={id} label="Your review">
            <textarea
              id={id}
              rows={4}
              value={feedback}
              disabled={phase !== "ready"}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="Share what works well and what could be refined…"
            />
          </Field>
          <div className="sp-actions">
            {onPreview && (
              <Button
                disabled={!feedback.trim()}
                onClick={() =>
                  onPreview(
                    "Review preview",
                    <>
                      <p className="sp-example-note">This feedback preview has not been saved.</p>
                      <p>{feedback}</p>
                    </>,
                  )
                }
              >
                Preview review
              </Button>
            )}
            <Button
              disabled={!enabled("save-review") || !feedback.trim()}
              onClick={() => void act("save-review")}
            >
              Save review
            </Button>
            <Button
              variant="primary"
              disabled={!enabled("approve")}
              onClick={() => void act("approve")}
            >
              Approve to publish
            </Button>
          </div>
        </>
      ) : (
        <>
          <ul className="sp-requirements">
            <li>
              Work marked as completed: {current.state === "editing" ? "Pending" : "Complete"}
            </li>
            <li>Teacher approval: {current.state === "approved" ? "Approved" : "Pending"}</li>
          </ul>
          <div className="sp-actions">
            {current.state === "editing" && (
              <Button
                variant="primary"
                disabled={!enabled("complete")}
                onClick={() => void act("complete")}
              >
                Mark as completed
              </Button>
            )}
            {current.state === "completed" && (
              <Button
                variant="primary"
                disabled={!enabled("submit")}
                onClick={() => void act("submit")}
              >
                Send to teacher
              </Button>
            )}
            <Button disabled>Publish project</Button>
          </div>
        </>
      )}
      {!onAction && (
        <p className="sp-hint">Actions are unavailable until an authorized backend is connected.</p>
      )}
      <p className="sp-hint">
        Publishing requires a separate server check and is unavailable here.
      </p>
      {phase === "pending" && <p role="status">Saving…</p>}
      {message && (
        <p role="status" ref={messageRef} tabIndex={-1}>
          {message}
        </p>
      )}
      {error && (
        <p role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
    </section>
  );
}
