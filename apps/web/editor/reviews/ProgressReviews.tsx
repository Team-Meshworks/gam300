import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import {
  createProgressReviewClient,
  type ProgressIntent,
  type ProgressReview,
} from "./progress-review-client";
import type { LeaveGuard } from "./ReviewWorkspace";

const client = createProgressReviewClient();
export function ProgressReviewList({ items }: { items: ProgressReview[] }) {
  return (
    <div className="sp-progress-list">
      {[...items]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((item) => (
          <article className="sp-progress-entry" key={item.id}>
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
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
}: {
  projectId: string;
  revision: number;
  actorId: string;
  educator: boolean;
  onGuard: (guard: LeaveGuard) => void;
  autoOpen?: boolean;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<ProgressReview[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(autoOpen);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [intent, setIntent] = useState<ProgressIntent | null>(null);
  const [phase, setPhase] = useState<"ready" | "sending" | "unknown">("ready");
  const [conflict, setConflict] = useState(false);
  const active = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const load = useCallback(
    async (after?: string | null) => {
      const version = generation.current;
      setLoading(true);
      setError("");
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
          setError(failure instanceof Error ? failure.message : "Reviews could not be loaded.");
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
    onGuard({ pending: phase !== "ready", dirty: !!feedback });
  }, [onGuard, phase, feedback]);
  useEffect(() => {
    if (!feedback && phase === "ready") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [feedback, phase]);
  function close() {
    if (phase !== "ready") return;
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
  const history = (
    <>
      {loading && <p role="status">Loading reviews…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && items.length === 0 && <p>No progress reviews yet.</p>}
      <ProgressReviewList items={items} />
      {cursor && (
        <Button disabled={loading || phase !== "ready"} onClick={() => void load(cursor)}>
          Load more reviews
        </Button>
      )}
      {error && phase === "ready" && (
        <Button onClick={() => void load()}>Retry loading reviews</Button>
      )}
    </>
  );
  if (!educator)
    return (
      <section className="sp-card sp-reviews" aria-label="Progress reviews">
        <h3>Progress reviews</h3>
        {history}
      </section>
    );
  return (
    <>
      {!autoOpen && <Button onClick={() => setOpen(true)}>Reviews</Button>}
      {open && (
        <Dialog title="Reviews" variant="progress" onClose={close}>
          {history}
          {editing ? (
            <div className="sp-progress-draft">
              <time>
                {new Date().toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </time>
              <label htmlFor="progress-feedback">New review</label>
              <textarea
                id="progress-feedback"
                rows={3}
                maxLength={4000}
                value={feedback}
                disabled={phase !== "ready"}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>
          ) : (
            <Button className="sp-progress-add" variant="primary" onClick={() => setEditing(true)}>
              + Add Reviews
            </Button>
          )}
          <div className="sp-actions sp-progress-actions">
            {phase === "unknown" ? (
              <Button variant="primary" onClick={() => void save(true)}>
                Retry same request
              </Button>
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
                  Save Changes
                </Button>
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
