import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import { assignmentSession, enrolledStudents, type AssignmentDetails } from "./assignment-api";
import {
  assignmentEditKey,
  readAssignmentEdit,
  submitAssignmentEdit,
  type PendingAssignmentEdit,
} from "./assignment-edit";
import { dueDateInput, localDateToDueUnixSeconds } from "./deadline";
import { StudentSelector } from "./StudentSelector";
import type { EligibleStudent } from "./new-project-form";

export function AssignmentEditDialog({
  classId,
  actorId,
  details,
  onClose,
  onSaved,
}: {
  classId: string;
  actorId: string;
  details: AssignmentDetails;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(details.title);
  const [description, setDescription] = useState(details.description);
  const [instructions, setInstructions] = useState(details.instructions);
  const [dueDate, setDueDate] = useState(() => dueDateInput(details.dueAtUnixSeconds));
  const [selected, setSelected] = useState(() =>
    details.projects.map((project) => project.studentId),
  );
  const [students, setStudents] = useState<EligibleStudent[] | null>(null);
  const [pending, setPending] = useState<PendingAssignmentEdit | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "sending" | "unknown" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const initialIds = details.projects
    .map((project) => project.studentId)
    .sort()
    .join(",");
  const dirty =
    title !== details.title ||
    description !== details.description ||
    instructions !== details.instructions ||
    dueDate !== dueDateInput(details.dueAtUnixSeconds) ||
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
          setDueDate(dueDateInput(earlier.body.dueAtUnixSeconds));
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
    if (dirty && phase !== "unknown" && !window.confirm("Discard your unsaved project changes?"))
      return;
    onClose();
  }
  async function save(retry = false) {
    if (inFlight.current || phase === "sending" || !navigator.locks) {
      if (!navigator.locks) setMessage("This browser cannot safely save changes.");
      return;
    }
    const due = localDateToDueUnixSeconds(dueDate);
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
  const missing = selected.filter(
    (id) => students && !students.some((student) => student.id === id),
  );
  return (
    <Dialog title="Edit project details" onClose={close}>
      {message && <p role="alert">{message}</p>}
      {phase === "loading" && <p role="status">Loading students…</p>}
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
      <fieldset disabled={phase !== "ready"}>
        <Field id="edit-assignment-title" label="Project title" required>
          <input
            id="edit-assignment-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
          />
        </Field>
        <Field id="edit-assignment-due" label="Due date" required>
          <input
            id="edit-assignment-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </Field>
        <Field id="edit-assignment-description" label="Project description" required>
          <textarea
            id="edit-assignment-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field id="edit-assignment-instructions" label="Project instructions" required>
          <textarea
            id="edit-assignment-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {students && (
          <StudentSelector
            students={students}
            selected={selected}
            onChange={(ids) => setSelected([...ids])}
          />
        )}
        {missing.map((id) => (
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
          <Button variant="primary" onClick={() => void save(true)}>
            Retry same request
          </Button>
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
    </Dialog>
  );
}
