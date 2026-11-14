import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import {
  assignmentSession,
  enrolledStudents,
  readAssignment,
  type AssignmentDetails,
} from "./assignment-api";
import {
  assignmentEditKey,
  editDeadline,
  readAssignmentEdit,
  submitAssignmentEdit,
  supersededAssignment,
  type PendingAssignmentEdit,
} from "./assignment-edit";
import { localDeadlineInput } from "./deadline";
import { StudentSelector } from "./StudentSelector";
import type { EligibleStudent } from "./new-project-form";

export function AssignmentEditDialog({
  classId,
  actorId,
  details,
  onClose,
  onSaved,
  field,
  inline = false,
}: {
  inline?: boolean;
  field?: "dueDate" | "description" | "instructions";
  classId: string;
  actorId: string;
  details: AssignmentDetails;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(details.title);
  const [description, setDescription] = useState(details.description);
  const [instructions, setInstructions] = useState(details.instructions);
  const [dueDate, setDueDate] = useState(() => localDeadlineInput(details.dueAtUnixSeconds));
  const [selected, setSelected] = useState(() =>
    details.projects.map((project) => project.studentId),
  );
  const [students, setStudents] = useState<EligibleStudent[] | null>(null);
  const [pending, setPending] = useState<PendingAssignmentEdit | null>(null);
  const [latest, setLatest] = useState<AssignmentDetails | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "sending" | "unknown" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const inlineRoot = useRef<HTMLDivElement>(null);
  const focusedInline = useRef(false);
  useEffect(() => {
    if (inline && phase === "ready" && !focusedInline.current) {
      inlineRoot.current
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
        ?.focus();
      focusedInline.current = true;
    }
  }, [inline, phase]);
  const initialIds = details.projects
    .map((project) => project.studentId)
    .sort()
    .join(",");
  const dirty =
    title !== details.title ||
    description !== details.description ||
    instructions !== details.instructions ||
    dueDate !== localDeadlineInput(details.dueAtUnixSeconds) ||
    [...selected].sort().join(",") !== initialIds;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const earlier = readAssignmentEdit(localStorage, actorId, classId, details.assignmentId);
        const roster = await enrolledStudents(classId, controller.signal);
        const identity = await assignmentSession(controller.signal);
        if (identity.userId !== actorId || identity.mustChangePassword)
          throw new Error("Your account changed. Reload before continuing.");
        if (controller.signal.aborted) return;
        setStudents(roster);
        if (earlier) {
          setPending(earlier);
          setTitle(earlier.body.title);
          setDescription(earlier.body.description);
          setInstructions(earlier.body.instructions);
          setDueDate(localDeadlineInput(earlier.body.dueAtUnixSeconds));
          setSelected(earlier.body.studentIds);
          setPhase("unknown");
          setMessage("An earlier save could not be confirmed. Retry the same request.");
        } else setPhase("ready");
      } catch (error) {
        if (!controller.signal.aborted) {
          setPhase("error");
          setMessage(
            error instanceof Error ? error.message : "The student list could not be loaded.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [actorId, classId, details.assignmentId, attempt]);
  useEffect(() => {
    if (!dirty && phase !== "sending") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, phase]);
  function close() {
    if (phase === "sending") return;
    if (
      !inline &&
      dirty &&
      phase !== "unknown" &&
      !window.confirm("Discard your unsaved project changes?")
    )
      return;
    onClose();
  }
  async function save(retry = false) {
    if (inFlight.current || phase === "sending" || !navigator.locks) {
      if (!navigator.locks) setMessage("This browser cannot safely save changes.");
      return;
    }
    const due = editDeadline(
      dueDate,
      localDeadlineInput(details.dueAtUnixSeconds),
      details.dueAtUnixSeconds,
    );
    if (
      !retry &&
      (!title.trim() ||
        !description.trim() ||
        !instructions.trim() ||
        due === null ||
        details.revision === undefined ||
        !students ||
        !selected.length ||
        selected.length > 20 ||
        selected.some((id) => !students.some((student) => student.id === id)))
    ) {
      setMessage("Check the project details, due date and selected enrolled students.");
      return;
    }
    const request = retry
      ? pending
      : {
          actorId,
          classId,
          assignmentId: details.assignmentId,
          body: {
            mutationId: crypto.randomUUID(),
            expectedRevision: details.revision!,
            title: title.trim(),
            description,
            instructions,
            dueAtUnixSeconds: due!,
            studentIds: [...selected],
          },
        };
    if (!request) return;
    inFlight.current = true;
    let safelyStored = false;
    setPhase("sending");
    setMessage("");
    try {
      const result = await navigator.locks.request(
        assignmentEditKey(actorId, details.assignmentId),
        async () => {
          const existing = readAssignmentEdit(localStorage, actorId, classId, details.assignmentId);
          if (existing && JSON.stringify(existing) !== JSON.stringify(request))
            return {
              kind: "rejected" as const,
              message: "Resolve the earlier save before starting another.",
            };
          if (!existing) {
            const saved = JSON.stringify(request);
            localStorage.setItem(assignmentEditKey(actorId, details.assignmentId), saved);
            if (localStorage.getItem(assignmentEditKey(actorId, details.assignmentId)) !== saved)
              throw new Error("Storage unavailable");
          }
          safelyStored = true;
          const outcome = await submitAssignmentEdit(request, retry || !!existing);
          if (outcome.kind === "confirmed" || (outcome.kind === "rejected" && !existing)) {
            localStorage.removeItem(assignmentEditKey(actorId, details.assignmentId));
          }
          return outcome;
        },
      );
      if (result.kind === "confirmed") {
        setPending(null);
        onSaved();
      } else if (result.kind === "rejected") {
        setPending(null);
        setPhase("ready");
        setMessage(result.message);
      } else {
        setPending(request);
        setPhase("unknown");
        setMessage("The save could not be confirmed. Retry the same request.");
      }
    } catch {
      if (!safelyStored) {
        setPhase("ready");
        setMessage(
          "The browser could not safely store this request. Your changes were not sent and are still here.",
        );
      } else {
        setPending(request);
        setPhase("unknown");
        setMessage("The save could not be confirmed. Retry the same request.");
      }
    } finally {
      inFlight.current = false;
    }
  }
  async function reviewLatest(discard = false) {
    if (!pending || !navigator.locks || inFlight.current) return;
    inFlight.current = true;
    setPhase("sending");
    try {
      const current = await navigator.locks.request(
        assignmentEditKey(actorId, details.assignmentId),
        async () => {
          const stored = readAssignmentEdit(localStorage, actorId, classId, details.assignmentId);
          if (JSON.stringify(stored) !== JSON.stringify(pending))
            throw new Error("The saved request changed. Reopen this dialog.");
          const identity = await assignmentSession();
          if (identity.userId !== actorId || identity.mustChangePassword)
            throw new Error("Your account changed. Reload before continuing.");
          const result = await readAssignment(classId, details.assignmentId);
          const after = await assignmentSession();
          if (after.userId !== actorId || after.mustChangePassword)
            throw new Error("Your account changed. Reload before continuing.");
          if (!supersededAssignment(pending, result))
            throw new Error("The latest version has not advanced. Retry the same request.");
          if (discard && latest?.revision === result.revision) {
            localStorage.removeItem(assignmentEditKey(actorId, details.assignmentId));
            if (localStorage.getItem(assignmentEditKey(actorId, details.assignmentId)) !== null)
              throw new Error("The saved request could not be cleared.");
            return null;
          }
          return result;
        },
      );
      if (!current) {
        setPending(null);
        onSaved();
      } else {
        setLatest(current);
        setPhase("unknown");
        setMessage(
          "The earlier save may or may not have been applied. Review the latest version before discarding the uncertain request.",
        );
      }
    } catch (error) {
      setPhase("unknown");
      setMessage(
        error instanceof Error ? error.message : "The latest version could not be loaded.",
      );
    } finally {
      inFlight.current = false;
    }
  }
  const showAll = !field || Boolean(pending);
  const missing = selected.filter(
    (id) => students && !students.some((student) => student.id === id),
  );
  const heading =
    field === "dueDate"
      ? "Edit Due Date"
      : field === "description"
        ? "Edit Project Description"
        : field === "instructions"
          ? "Edit Project Instructions"
          : "Edit project details";
  const content = (
    <>
      {message && <p role="alert">{message}</p>}
      {phase === "loading" && (
        <p role="status">{inline ? "Checking details…" : "Loading students…"}</p>
      )}
      {phase === "error" && (
        <Button
          onClick={() => {
            setPhase("loading");
            setAttempt((value) => value + 1);
          }}
        >
          Retry loading students
        </Button>
      )}
      {latest && phase === "unknown" && (
        <section aria-label="Latest assignment version">
          <h3>Latest version</h3>
          <p>{latest.title}</p>
          <p>{latest.description}</p>
          <p>{latest.instructions}</p>
          <p>Due date and time: {localDeadlineInput(latest.dueAtUnixSeconds)}</p>
          <p>
            Students:{" "}
            {latest.projects.map((project) => project.studentName ?? project.studentId).join(", ")}
          </p>
          <p>
            Discarding removes the uncertain request and its displayed changes; it does not undo any
            earlier save.
          </p>
        </section>
      )}
      <fieldset disabled={phase !== "ready"}>
        {showAll && (
          <Field id="edit-assignment-title" label="Project title">
            <input
              id="edit-assignment-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
            />
          </Field>
        )}
        {(showAll || field === "dueDate") && (
          <Field id="edit-assignment-due" label="Due date and time">
            <input
              id="edit-assignment-due"
              type="datetime-local"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </Field>
        )}
        {(showAll || field === "description") && (
          <Field id="edit-assignment-description" label="Project description">
            <textarea
              id="edit-assignment-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        )}
        {(showAll || field === "instructions") && (
          <Field id="edit-assignment-instructions" label="Project instructions">
            <textarea
              id="edit-assignment-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>
        )}
        {showAll && students && (
          <StudentSelector
            students={students}
            selected={selected}
            onChange={(ids) => setSelected([...ids])}
          />
        )}
        {showAll &&
          missing.map((id) => (
            <p key={id}>
              A previously assigned student is no longer enrolled.{" "}
              <Button onClick={() => setSelected((ids) => ids.filter((value) => value !== id))}>
                Remove{" "}
                {details.projects.find((project) => project.studentId === id)?.studentName ??
                  "student"}
              </Button>
            </p>
          ))}
      </fieldset>
      <div className="sp-actions">
        <Button disabled={phase === "sending"} onClick={close}>
          Cancel
        </Button>
        {phase === "unknown" ? (
          <>
            <Button onClick={() => void reviewLatest()}>Review latest version</Button>
            {latest && (
              <Button onClick={() => void reviewLatest(true)}>
                Discard uncertain request and use latest
              </Button>
            )}
            <Button variant="primary" onClick={() => void save(true)}>
              Retry same request
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={phase !== "ready" || !dirty}
            onClick={() => void save()}
          >
            Save changes
          </Button>
        )}
      </div>
    </>
  );
  // Reuse the same request and recovery controls in either presentation
  return inline ? (
    <div ref={inlineRoot} className="sp-assignment-inline" role="group" aria-label={heading}>
      {content}
    </div>
  ) : (
    <Dialog
      title={heading}
      variant="account"
      className={`sp-assignment-edit-dialog${field === "dueDate" ? " sp-assignment-edit-dialog--date" : ""}`}
      closeDisabled={phase === "sending"}
      onClose={close}
    >
      {content}
    </Dialog>
  );
}
