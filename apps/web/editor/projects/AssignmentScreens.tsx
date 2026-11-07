import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { NewProjectForm, type FormNavigationState } from "./NewProjectForm";
import { formatLocalDeadline, localDeadlineToUnixSeconds } from "./deadline";
import { createWorkspaceClient, isRecord } from "../home/workspace-api";
import { blankSourceKey, createBlankSource } from "./blank-source";
import "./assignment-screens.css";
import {
  assignmentChoices,
  assignmentSession,
  enrolledStudents,
  listAssignments,
  readAssignment,
  submitAssignment,
  type AssignmentDetails,
  type AssignmentSession,
  type PendingAssignment,
  type SourceProject,
} from "./assignment-api";
import type {
  EligibleStudent,
  NewProjectDraft,
  ProjectClass,
  ProjectCreationResult,
} from "./new-project-form";

type Setup = { session: AssignmentSession; classes: ProjectClass[]; projects: SourceProject[] };
const pendingKey = (userId: string) => `spatia.assignment.pending:${userId}`;
const workspace = createWorkspaceClient();

function loadPending(userId: string): PendingAssignment | null {
  const raw = localStorage.getItem(pendingKey(userId));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("body" in value) ||
    !("actorId" in value) ||
    !("classId" in value) ||
    value.actorId !== userId ||
    typeof value.classId !== "string" ||
    typeof value.body !== "object" ||
    value.body === null
  )
    throw new Error("Pending assignment is unavailable.");
  const body = value.body as Record<string, unknown>;
  if (
    typeof body.requestId !== "string" ||
    typeof body.sourceProjectId !== "string" ||
    typeof body.sourceRevision !== "number" ||
    !Number.isSafeInteger(body.sourceRevision) ||
    typeof body.dueAtUnixSeconds !== "number" ||
    !Number.isSafeInteger(body.dueAtUnixSeconds) ||
    typeof body.title !== "string" ||
    typeof body.description !== "string" ||
    typeof body.instructions !== "string" ||
    !Array.isArray(body.studentIds) ||
    body.studentIds.length < 1 ||
    body.studentIds.length > 20 ||
    body.studentIds.some((id) => typeof id !== "string")
  )
    throw new Error("Pending assignment is unavailable.");
  return value as PendingAssignment;
}

export function AssignmentCreationScreen({
  onOpenProject,
  onCancel,
  expectedUserId,
  onNavigationStateChange,
  createBlank = false,
}: {
  onOpenProject?: (projectId: string) => void;
  onCancel?: () => void;
  expectedUserId?: string;
  onNavigationStateChange?: (state: FormNavigationState) => void;
  createBlank?: boolean;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [message, setMessage] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceUncertain, setSourceUncertain] = useState<"unknown" | "unavailable" | null>(null);
  const [students, setStudents] = useState<EligibleStudent[]>([]);
  const [rosterMessage, setRosterMessage] = useState("");
  const [choicesMessage, setChoicesMessage] = useState("");
  const [pending, setPending] = useState<PendingAssignment | null>(null);
  const [restoredPending, setRestoredPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formNavigation, setFormNavigation] = useState<FormNavigationState>({
    dirty: false,
    locked: false,
  });
  const [confirmed, setConfirmed] = useState<{ classId: string; assignmentId: string } | null>(
    null,
  );
  const rosterController = useRef<AbortController | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await assignmentSession(controller.signal);
        if (expectedUserId && session.userId !== expectedUserId) {
          setMessage("The account changed. Reload before creating an assignment.");
          return;
        }
        if (session.role !== "Educator" && session.role !== "Administrator") {
          setMessage("Class assignment creation is unavailable for this account.");
          return;
        }
        const saved = loadPending(session.userId);
        if (createBlank && !saved) {
          const stored = localStorage.getItem(blankSourceKey(session.userId));
          if (stored) {
            const parsed: unknown = JSON.parse(stored);
            setSourceUncertain(!isRecord(parsed) || !isRecord(parsed.receipt) ? "unknown" : null);
          }
        }
        const choices = saved
          ? { classes: [], projects: [] }
          : await assignmentChoices(controller.signal);
        if (controller.signal.aborted) return;
        setSetup({ session, ...choices });
        setPending(saved);
        setRestoredPending(saved !== null);
      } catch {
        if (!controller.signal.aborted)
          setMessage("Class assignment information is unavailable. Reload to try again.");
      }
    })();
    return () => {
      controller.abort();
      rosterController.current?.abort();
    };
  }, [expectedUserId, createBlank]);
  useLayoutEffect(() => {
    onNavigationStateChange?.({
      dirty: !confirmed && !pending && (formNavigation.dirty || !!sourceId),
      locked: busy || formNavigation.locked,
    });
  }, [confirmed, pending, formNavigation, sourceId, busy, onNavigationStateChange]);
  useEffect(
    () => () => onNavigationStateChange?.({ dirty: false, locked: false }),
    [onNavigationStateChange],
  );

  function changeClass(classId: string) {
    rosterController.current?.abort();
    setStudents([]);
    setRosterMessage(classId ? "Loading enrolled students…" : "");
    if (!classId) return;
    const controller = new AbortController();
    rosterController.current = controller;
    void enrolledStudents(classId, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setStudents(rows);
          setRosterMessage(rows.length ? "" : "No enrolled students are available in this class.");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRosterMessage("The roster is unavailable. Choose the class again to retry.");
      });
  }

  async function refreshChoices() {
    if (!setup || pending) return;
    setChoicesMessage("Refreshing projects and classes…");
    try {
      const session = await assignmentSession();
      if (session.userId !== setup.session.userId) {
        setMessage("The account changed. Reload before creating an assignment.");
        return;
      }
      const choices = await assignmentChoices();
      setSetup({ session, ...choices });
      setChoicesMessage("Projects and classes refreshed.");
    } catch {
      setChoicesMessage("Projects and classes could not be refreshed. Your details are unchanged.");
    }
  }

  async function attempt(
    request: PendingAssignment,
    previouslyUncertain: boolean,
    newRequest = false,
  ): Promise<ProjectCreationResult> {
    if (inFlight.current) return { kind: "unknown" };
    if (!navigator.locks)
      return newRequest
        ? { kind: "rejected", message: "This browser cannot safely coordinate assignment retries." }
        : { kind: "unknown" };
    inFlight.current = true;
    setBusy(true);
    let stored = false;
    try {
      return await navigator.locks.request(`spatia.assignment:${request.actorId}`, async () => {
        const existing = loadPending(request.actorId);
        if (newRequest && existing) {
          setPending(existing);
          setRestoredPending(true);
          return {
            kind: "rejected",
            message: "Resolve the earlier assignment before creating another.",
          };
        }
        if (newRequest) {
          localStorage.setItem(pendingKey(request.actorId), JSON.stringify(request));
          stored = true;
          setPending(request);
        } else if (JSON.stringify(existing) !== JSON.stringify(request)) {
          setMessage(
            "The earlier request changed in another tab. Reload and check your assignments.",
          );
          return { kind: "unknown" };
        }
        const result = await submitAssignment(request, previouslyUncertain);
        if (result.kind === "confirmed") {
          localStorage.removeItem(pendingKey(request.actorId));
          if (createBlank) localStorage.removeItem(blankSourceKey(request.actorId));
          setPending(null);
          setConfirmed({ classId: request.classId, assignmentId: result.assignmentId });
          if (createBlank)
            location.assign(
              `/home?${new URLSearchParams({ classId: request.classId, assignmentId: result.assignmentId })}`,
            );
          changeClass(request.classId);
          return { kind: "created", projectId: result.projects[0]!.projectId };
        }
        if (result.kind === "rejected") {
          localStorage.removeItem(pendingKey(request.actorId));
          setPending(null);
          return result;
        }
        return { kind: "unknown" };
      });
    } catch {
      return newRequest && !stored
        ? {
            kind: "rejected",
            message: "The browser could not save retry information. No assignment was sent.",
          }
        : { kind: "unknown" };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function create(draft: NewProjectDraft): Promise<ProjectCreationResult> {
    if (!setup || pending)
      return {
        kind: "rejected",
        message: "Resolve the earlier assignment before creating another.",
      };
    const dueAtUnixSeconds = localDeadlineToUnixSeconds(draft.dueDate);
    if (dueAtUnixSeconds === null)
      return { kind: "rejected", message: "Choose a valid local due date and time." };
    let source = setup.projects.find((project) => project.projectId === sourceId);
    if (createBlank) {
      if (!navigator.locks)
        return {
          kind: "rejected",
          message: "This browser cannot safely coordinate project creation.",
        };
      const result = await navigator.locks.request(
        `spatia.assignment.source:${setup.session.userId}`,
        () =>
          createBlankSource(
            localStorage,
            workspace.write,
            setup.session.userId,
            draft.title.trim(),
            "",
            async (actorId, projectId) => {
              try {
                if ((await assignmentSession()).userId !== actorId) return { kind: "retry" };
                const projects = await workspace.projects(false);
                if ((await assignmentSession()).userId !== actorId) return { kind: "retry" };
                const current = projects.find(
                  (project) => project.projectId.toLowerCase() === projectId.toLowerCase(),
                );
                return current?.permissions.canManage
                  ? { kind: "available", revision: current.revision }
                  : { kind: "unavailable" };
              } catch {
                return { kind: "retry" };
              }
            },
          ),
      );
      if (result.kind === "unknown") {
        setSourceUncertain("unknown");
        return { kind: "unknown" };
      }
      if (result.kind === "source-unavailable") {
        setSourceUncertain("unavailable");
        return {
          kind: "rejected",
          message:
            "The source project is no longer available. Check your projects before starting again.",
        };
      }
      if (result.kind === "rejected") return result;
      setSourceUncertain(null);
      source = { projectId: result.projectId, title: draft.title, revision: result.revision };
    }
    if (!source) return { kind: "rejected", message: "Choose an existing source project." };
    const request: PendingAssignment = {
      actorId: setup.session.userId,
      classId: draft.classId,
      body: {
        requestId: crypto.randomUUID(),
        sourceProjectId: source.projectId,
        sourceRevision: source.revision,
        dueAtUnixSeconds,
        title: draft.title,
        description: draft.description,
        instructions: draft.instructions,
        studentIds: [...draft.studentIds],
      },
    };
    return attempt(request, false, true);
  }

  if (message) return <p role="alert">{message}</p>;
  if (!setup) return <p role="status">Loading assignment choices…</p>;
  if (confirmed)
    return (
      <AssignmentDetailsScreen
        {...confirmed}
        studentNames={Object.fromEntries(students.map((student) => [student.id, student.name]))}
        {...(onOpenProject ? { onOpenProject } : {})}
      />
    );
  return (
    <section aria-label="Create class assignment" className="sp-assignment-create">
      {sourceUncertain && !pending && (
        <div role="alert" className="sp-creation-notice">
          <p>
            {sourceUncertain === "unavailable"
              ? "The source project is no longer available or cannot be managed. You can create a new source without losing these assignment details."
              : "Creating the source project could not be confirmed. Check your projects before trying again to avoid creating a duplicate."}
          </p>
          <Button
            onClick={() => {
              try {
                localStorage.removeItem(blankSourceKey(setup.session.userId));
                if (sourceUncertain === "unavailable") setSourceUncertain(null);
                else location.assign("/home");
              } catch {
                setMessage(
                  "The recovery warning could not be cleared. Your project may still exist.",
                );
              }
            }}
          >
            {sourceUncertain === "unavailable" ? "Use a new source project" : "I checked my projects"}
          </Button>
        </div>
      )}
      {pending && (
        <div role="status" className="sp-creation-notice">
          <p>
            The assignment outcome may be unknown. Retry the same request before creating another.
          </p>
          <Button
            disabled={busy}
            onClick={() => {
              void attempt(pending, true);
            }}
          >
            {busy ? "Checking assignment…" : "Retry same assignment"}
          </Button>
        </div>
      )}
      {!restoredPending && (
        <>
          {!createBlank && (
            <>
              <Field id="assignment-source" label="Source project" required>
                <select
                  id="assignment-source"
                  value={sourceId}
                  disabled={!!pending}
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  <option value="">Choose a manageable project</option>
                  {setup.projects.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </Field>
              {!setup.projects.length && (
                <p role="status">No manageable source projects are available.</p>
              )}
              {!setup.classes.length && <p role="status">No classes are available.</p>}
              <Button
                disabled={!!pending}
                onClick={() => {
                  void refreshChoices();
                }}
              >
                Refresh projects and classes
              </Button>
              {choicesMessage && <p role="status">{choicesMessage}</p>}
            </>
          )}
          {rosterMessage && <p role="status">{rosterMessage}</p>}
          <NewProjectForm
            organizationName="Selected class's organisation"
            creatorName={setup.session.displayName}
            classes={setup.classes}
            students={students}
            showImageOptions={false}
            onClassChange={changeClass}
            onSubmit={create}
            {...(onCancel ? { onCancel } : {})}
            onNavigationStateChange={setFormNavigation}
          />
        </>
      )}
    </section>
  );
}

export function AssignmentDetailsScreen({
  classId,
  assignmentId,
  studentNames,
  onOpenProject,
  ownProject = false,
}: {
  classId: string;
  assignmentId: string;
  studentNames?: Record<string, string>;
  onOpenProject?: (projectId: string) => void;
  ownProject?: boolean;
}) {
  const key = `${classId}:${assignmentId}`;
  const [result, setResult] = useState<{ key: string; details: AssignmentDetails | null } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    void readAssignment(classId, assignmentId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult({ key, details: value });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, details: null });
      });
    return () => controller.abort();
  }, [classId, assignmentId, key]);
  if (!result || result.key !== key) return <p role="status">Loading assignment…</p>;
  if (!result.details)
    return <p role="alert">This assignment is unavailable for the current account.</p>;
  const details = result.details;
  return (
    <section aria-label="Assignment details" className="sp-assignment-details">
      <h2>{details.title}</h2>
      <p>{details.description}</p>
      <h3>Instructions</h3>
      <p>{details.instructions}</p>
      <p>Due: {formatLocalDeadline(details.dueAtUnixSeconds) ?? "Unavailable"}</p>
      {details.projects.map((project) => (
        <Button
          key={project.projectId}
          disabled={
            !onOpenProject ||
            (!ownProject && !(project.studentName ?? studentNames?.[project.studentId]))
          }
          onClick={() => onOpenProject?.(project.projectId)}
        >
          {ownProject
            ? "Open your project"
            : (project.studentName ?? studentNames?.[project.studentId])
              ? `Open project for ${project.studentName ?? studentNames?.[project.studentId]}`
              : "Student name unavailable"}
        </Button>
      ))}
      {!onOpenProject && (
        <p className="sp-hint">
          Opening projects is not available yet. You can read your assignment and instructions here.
        </p>
      )}
    </section>
  );
}

export function AssignmentListScreen({
  classId,
  onOpenProject,
  studentNames,
  ownProject = false,
}: {
  classId: string;
  onOpenProject?: (projectId: string) => void;
  studentNames?: Record<string, string>;
  ownProject?: boolean;
}) {
  const [result, setResult] = useState<{
    classId: string;
    items: AssignmentDetails[] | null;
  } | null>(null);
  const [selected, setSelected] = useState<{ classId: string; assignmentId: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listAssignments(classId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setResult({ classId, items });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ classId, items: null });
      });
    return () => controller.abort();
  }, [classId]);
  if (selected?.classId === classId)
    return (
      <>
        <Button onClick={() => setSelected(null)}>Back to assignments</Button>
        <AssignmentDetailsScreen
          key={selected.assignmentId}
          classId={classId}
          assignmentId={selected.assignmentId}
          ownProject={ownProject}
          {...(studentNames ? { studentNames } : {})}
          {...(onOpenProject ? { onOpenProject } : {})}
        />
      </>
    );
  if (!result || result.classId !== classId) return <p role="status">Loading assignments…</p>;
  if (!result.items)
    return <p role="alert">Assignments are unavailable for the current account.</p>;
  if (!result.items.length) return <p role="status">No assignments are available.</p>;
  return (
    <section aria-label="Class assignments">
      <h2>Assignments</h2>
      <ul className="sp-assignment-list">
        {result.items.map((item) => (
          <li key={item.assignmentId}>
            <Button onClick={() => setSelected({ classId, assignmentId: item.assignmentId })}>
              {item.title}
            </Button>
            <span> Due: {formatLocalDeadline(item.dueAtUnixSeconds) ?? "Unavailable"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
