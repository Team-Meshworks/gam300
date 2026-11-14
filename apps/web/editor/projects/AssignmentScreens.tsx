import { ExistingProjectPicker } from "../home/ExistingProjectPicker";
import { createExistingProjectClient } from "../home/existing-project";
import { PendingCreateRecovery } from "../home/PendingCreateRecovery";
import { Table } from "../../shared/ui/Table";
import { encodeProjectImage, type EncodedProjectImage } from "./project-image";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { NewProjectForm, type FormNavigationState } from "./NewProjectForm";
import {
  formatLocalDeadline,
  localDateToDueUnixSeconds,
  localDeadlineToUnixSeconds,
} from "./deadline";
import { createWorkspaceClient } from "../home/workspace-api";
import { acknowledgeCreation, loadCreationHead } from "../home/create-operation";
import {
  blankSourceKey,
  adoptBlankSource,
  adoptedBlankSource,
  historicalBlankSource,
  uncorrelatedBlankSource,
  selectedExistingSource,
  selectExistingSource,
  verifySelectedSource,
  blankSourceAttempt,
  blankSourceProject,
  clearBlankSource,
  createBlankSource,
} from "./blank-source";
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

type Setup = {
  session: AssignmentSession;
  classes: ProjectClass[];
  projects: SourceProject[];
};
const pendingKey = (userId: string) => `spatia.assignment.pending:${userId}`;
const workspace = createWorkspaceClient();
const existingProjects = createExistingProjectClient();
async function verifyExistingSelection(actorId: string) {
  if (loadPending(actorId))
    throw new Error("Resolve the earlier assignment before selecting another source.");
  const current = await assignmentSession();
  if (current.userId !== actorId || current.mustChangePassword)
    throw new Error("The account changed. Reload before continuing.");
  if ((await loadCreationHead(actorId, "assignment-source")).state !== "ready")
    throw new Error(
      "Resolve the existing server source operation before choosing another project.",
    );
}

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
  if ("sourceSelection" in value) {
    if (typeof value.sourceSelection !== "string")
      throw new Error("The pending source selection could not be verified.");
    const selected = selectedExistingSource(value.sourceSelection, userId);
    if (
      !selected ||
      selected.projectId !== body.sourceProjectId ||
      selected.revision !== body.sourceRevision
    )
      throw new Error("The pending source selection does not match this assignment.");
  }
  return value as PendingAssignment;
}

export function AssignmentCreationScreen({
  onCreated,
  onOpenProject,
  onCancel,
  expectedUserId,
  onNavigationStateChange,
  createBlank = false,
  initialClassId = "",
}: {
  onCreated?: () => void;
  onOpenProject?: (projectId: string) => void;
  onCancel?: () => void;
  expectedUserId?: string;
  onNavigationStateChange?: (state: FormNavigationState) => void;
  createBlank?: boolean;
  initialClassId?: string;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [message, setMessage] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [recoveredSource, setRecoveredSource] = useState<SourceProject | null>(null);
  const [manualSource, setManualSource] = useState(false);
  const [existingSourceOpen, setExistingSourceOpen] = useState(false);
  const [sourceObserved, setSourceObserved] = useState<string | null>(null);
  const [sourceUncertain, setSourceUncertain] = useState<{
    reason: "unknown" | "unavailable" | "image" | "retry" | "adopted" | "historical" | "existing";
    record: string | null;
  } | null>(null);
  const [students, setStudents] = useState<EligibleStudent[]>([]);
  const [initialClass, setInitialClass] = useState("");
  const [rosterMessage, setRosterMessage] = useState("");
  const [choicesMessage, setChoicesMessage] = useState("");
  const [pending, setPending] = useState<PendingAssignment | null>(null);
  const [restoredPending, setRestoredPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formNavigation, setFormNavigation] = useState<FormNavigationState>({
    dirty: false,
    locked: false,
  });
  const [confirmed, setConfirmed] = useState<{
    classId: string;
    assignmentId: string;
  } | null>(null);
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
          if (stored !== null && uncorrelatedBlankSource(stored)) {
            setSourceUncertain({ reason: "historical", record: stored });
            setExistingSourceOpen(true);
            setSourceObserved(stored);
          } else if (
            stored !== null &&
            !blankSourceProject(stored) &&
            !selectedExistingSource(stored, session.userId)
          )
            setSourceUncertain({
              reason: blankSourceAttempt(stored) ? "retry" : "unknown",
              record: stored,
            });
        }
        const choices = saved
          ? { classes: [], projects: [] }
          : await assignmentChoices(controller.signal);
        const current = await assignmentSession(controller.signal);
        if (
          current.userId !== session.userId ||
          current.role !== session.role ||
          current.mustChangePassword
        )
          throw new Error("Your account changed. Reload before continuing.");
        if (createBlank && !saved) {
          const record = localStorage.getItem(blankSourceKey(session.userId));
          const selected = record === null ? null : selectedExistingSource(record, session.userId);
          if (selected && record !== null) {
            setManualSource(true);
            setSourceObserved(record);
            try {
              const checked = await existingProjects.confirm(
                session.userId,
                { ...selected, archived: false },
                true,
              );
              const retained = await selectExistingSource(
                localStorage,
                session.userId,
                record,
                checked,
                () => verifyExistingSelection(session.userId),
              );
              setSourceObserved(retained);
              setRecoveredSource(checked);
            } catch {
              setSourceUncertain({ reason: "existing", record });
              setExistingSourceOpen(true);
            }
          }
          const adopted = record === null ? null : adoptedBlankSource(record, session.userId);
          if (adopted) {
            const available = await workspace.projects(false, controller.signal, session.userId);
            const source = available.find(
              (project) => project.projectId === adopted.projectId && project.permissions.canManage,
            );
            if (!source) setSourceUncertain({ reason: "unavailable", record });
            else {
              await loadCreationHead(session.userId, "assignment-source");
              const ack = await acknowledgeCreation(
                session.userId,
                "assignment-source",
                adopted.operationId,
                workspace.write,
              );
              if (ack.kind === "confirmed") setRecoveredSource(source);
              else setSourceUncertain({ reason: "adopted", record });
            }
          }
        }
        if (controller.signal.aborted) return;
        const selectedClass = choices.classes.find((row) => row.id === initialClassId)?.id ?? "";
        setInitialClass(selectedClass);
        setSetup({ session, ...choices });
        setPending(saved);
        setRestoredPending(saved !== null);
        if (!saved && selectedClass) changeClass(selectedClass, session.userId);
      } catch (error) {
        if (!controller.signal.aborted)
          setMessage(
            error instanceof Error &&
              error.message === "Your account changed. Reload before continuing."
              ? error.message
              : "Class assignment information is unavailable. Reload to try again.",
          );
      }
    })();
    return () => {
      controller.abort();
      rosterController.current?.abort();
    };
  }, [expectedUserId, createBlank, initialClassId]);
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

  useEffect(() => {
    if (confirmed && onCreated) onCreated();
  }, [confirmed, onCreated]);

  function changeClass(classId: string, actorId: string) {
    rosterController.current?.abort();
    setStudents([]);
    setRosterMessage(classId ? "Loading enrolled students…" : "");
    if (!classId) return;
    const controller = new AbortController();
    rosterController.current = controller;
    void enrolledStudents(classId, controller.signal)
      .then(async (rows) => {
        const identity = await assignmentSession(controller.signal);
        if (
          identity.userId !== actorId ||
          identity.mustChangePassword ||
          (identity.role !== "Educator" && identity.role !== "Administrator")
        )
          throw new Error("Your account changed. Reload before continuing.");
        if (!controller.signal.aborted) {
          setStudents(rows);
          setRosterMessage(rows.length ? "" : "No enrolled students are available in this class.");
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setRosterMessage(
            error instanceof Error &&
              error.message === "Your account changed. Reload before continuing."
              ? error.message
              : "The roster is unavailable. Choose the class again to retry.",
          );
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
      const current = await assignmentSession();
      if (
        current.userId !== session.userId ||
        current.role !== session.role ||
        current.mustChangePassword
      )
        throw new Error("Account changed");
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
        ? {
            kind: "rejected",
            message: "This browser cannot safely coordinate assignment retries.",
          }
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
        const send = async (): Promise<ProjectCreationResult> => {
          if (newRequest && request.sourceSelection !== undefined) {
            try {
              const chosen = verifySelectedSource(
                localStorage,
                request.actorId,
                request.sourceSelection,
                { projectId: request.body.sourceProjectId, revision: request.body.sourceRevision },
              );
              await existingProjects.confirm(request.actorId, { ...chosen, archived: false }, true);
              await verifyExistingSelection(request.actorId);
            } catch (cause) {
              setRecoveredSource(null);
              setExistingSourceOpen(true);
              setSourceUncertain({ reason: "existing", record: request.sourceSelection });
              return {
                kind: "rejected",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "The selected existing source could not be verified.",
              };
            }
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
            if (createBlank) {
              if (newRequest && request.sourceSelection !== undefined) {
                const key = blankSourceKey(request.actorId);
                if (localStorage.getItem(key) === request.sourceSelection) {
                  localStorage.removeItem(key);
                  if (localStorage.getItem(key) !== null)
                    throw new Error("The source record could not be cleared.");
                }
              } else
                await clearBlankSource(
                  localStorage,
                  request.actorId,
                  request.sourceSelection !== undefined
                    ? { record: request.sourceSelection }
                    : { projectId: request.body.sourceProjectId },
                );
            }
            localStorage.removeItem(pendingKey(request.actorId));
            setPending(null);
            setConfirmed({
              classId: request.classId,
              assignmentId: result.assignmentId,
            });

            changeClass(request.classId, request.actorId);
            return {
              kind: "created",
              projectId: result.projects[0]!.projectId,
            };
          }
          if (result.kind === "rejected") {
            localStorage.removeItem(pendingKey(request.actorId));
            setPending(null);
            return result;
          }
          return { kind: "unknown" };
        };
        return newRequest && request.sourceSelection !== undefined
          ? navigator.locks.request(blankSourceKey(request.actorId), send)
          : send();
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
    const dueAtUnixSeconds = createBlank
      ? localDateToDueUnixSeconds(draft.dueDate)
      : localDeadlineToUnixSeconds(draft.dueDate);
    if (dueAtUnixSeconds === null)
      return {
        kind: "rejected",
        message: createBlank ? "Choose a valid due date." : "Choose a valid due date and time.",
      };
    let source =
      recoveredSource ?? setup.projects.find((project) => project.projectId === sourceId);
    if (createBlank) {
      let storedSource: string | null;
      try {
        storedSource = localStorage.getItem(blankSourceKey(setup.session.userId));
      } catch {
        return {
          kind: "rejected",
          message: "The browser could not verify the saved source. Your details are unchanged.",
        };
      }
      if (storedSource !== null && uncorrelatedBlankSource(storedSource)) {
        setSourceObserved(storedSource);
        setExistingSourceOpen(true);
        setSourceUncertain({ reason: "historical", record: storedSource });
        return {
          kind: "rejected",
          message:
            "Review the earlier source creation and choose an exact existing project, or explicitly start a separate creation after reviewing the list.",
        };
      }
      if (
        storedSource !== null &&
        selectedExistingSource(storedSource, setup.session.userId) &&
        !manualSource
      ) {
        setManualSource(true);
        setSourceObserved(storedSource);
        setExistingSourceOpen(true);
        setSourceUncertain({ reason: "existing", record: storedSource });
        return {
          kind: "rejected",
          message:
            "An existing source was selected in another tab. Review its exact project before using it.",
        };
      }
      if (manualSource && (!recoveredSource || sourceObserved === null))
        return {
          kind: "rejected",
          message: "Review the selected existing source before submitting.",
        };
    }
    if (createBlank && !recoveredSource && !manualSource) {
      let image: EncodedProjectImage | undefined;
      try {
        if (draft.coverImage)
          image = await encodeProjectImage(
            draft.coverImage,
            draft.imageType === "Cover image" ? "cover" : "panorama",
          );
        else if (draft.imageType !== "Cover image")
          return {
            kind: "rejected",
            message: "Choose a panorama image from Gallery first.",
          };
      } catch (cause) {
        return {
          kind: "rejected",
          message: cause instanceof Error ? cause.message : "The image could not be read.",
        };
      }
      if (!navigator.locks)
        return {
          kind: "rejected",
          message: "This browser cannot safely coordinate project creation.",
        };
      const key = blankSourceKey(setup.session.userId);
      const { result, record } = await navigator.locks.request(key, async () => {
        const result = await createBlankSource(
          localStorage,
          workspace.write,
          setup.session.userId,
          draft.title.trim(),
          "",
          async (actorId, projectId) => {
            try {
              const before = await assignmentSession();
              if (before.userId !== actorId || before.mustChangePassword) return { kind: "retry" };
              const projects = await workspace.projects(false, undefined, actorId);
              const after = await assignmentSession();
              if (after.userId !== actorId || after.mustChangePassword) return { kind: "retry" };
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
          image,
        );
        const record =
          result.kind === "unknown" ||
          result.kind === "image-mismatch" ||
          result.kind === "source-unavailable"
            ? localStorage.getItem(key)
            : null;
        return { result, record };
      });
      if (result.kind === "unknown") {
        if (
          record &&
          (blankSourceAttempt(record) || adoptedBlankSource(record, setup.session.userId))
        ) {
          const adopted = adoptedBlankSource(record, setup.session.userId);
          setSourceUncertain({ reason: adopted ? "adopted" : "retry", record });
          return {
            kind: "rejected",
            message: adopted
              ? "The recovered source is preserved. Confirm its acknowledgement in recovery; the original image is not required."
              : "Creation is unconfirmed. Submit the same project details and image again to recover the original project.",
          };
        }
        setSourceUncertain({ reason: "unknown", record });
        return { kind: "unknown" };
      }
      if (result.kind === "image-mismatch") {
        setSourceUncertain({ reason: "image", record });
        return {
          kind: "rejected",
          message:
            "The recovered project has a different image. Start a new project to use this selection.",
        };
      }
      if (result.kind === "source-unavailable") {
        setSourceUncertain({ reason: "unavailable", record });
        return {
          kind: "rejected",
          message: "The project is no longer available. Check your projects before starting again.",
        };
      }
      if (result.kind === "rejected") return result;
      setSourceUncertain(null);
      source = {
        projectId: result.projectId,
        title: draft.title,
        revision: result.revision,
      };
    }
    if (!source)
      return {
        kind: "rejected",
        message: "Choose an existing source project.",
      };
    const request: PendingAssignment = {
      actorId: setup.session.userId,
      classId: draft.classId,
      ...(manualSource && sourceObserved !== null ? { sourceSelection: sourceObserved } : {}),
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
  if (confirmed && onCreated) return <p role="status">Opening projects…</p>;
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
      {createBlank &&
        !pending &&
        !recoveredSource &&
        (() => {
          let stored: string | null;
          try {
            stored = localStorage.getItem(blankSourceKey(setup.session.userId));
          } catch {
            return null;
          }
          const receipt =
            stored !== null && historicalBlankSource(stored) ? blankSourceProject(stored) : null;
          if (!receipt) return null;
          const available = setup.projects.find(
            (project) => project.projectId === receipt.projectId,
          );
          return (
            <section className="sp-create-recovery" aria-label="Saved source project">
              <p>
                Saved source project ID: <code>{receipt.projectId}</code>
              </p>
              {available && (
                <Button
                  disabled={busy || formNavigation.locked}
                  onClick={() => {
                    setSourceObserved(stored);
                    setExistingSourceOpen(true);
                  }}
                >
                  Review saved source project {receipt.projectId}
                </Button>
              )}
            </section>
          );
        })()}
      {createBlank &&
        !pending &&
        (() => {
          let observed: string | null;
          try {
            observed = localStorage.getItem(blankSourceKey(setup.session.userId));
          } catch {
            return null;
          }
          const allowed =
            observed === null ||
            uncorrelatedBlankSource(observed) ||
            (existingSourceOpen &&
              historicalBlankSource(observed) &&
              blankSourceProject(observed) !== null) ||
            selectedExistingSource(observed, setup.session.userId) !== null;
          return allowed && (!recoveredSource || manualSource) ? (
            <>
              {!existingSourceOpen && (
                <Button
                  disabled={busy || formNavigation.locked}
                  onClick={() => {
                    setSourceObserved(observed);
                    setExistingSourceOpen(true);
                  }}
                >
                  {manualSource ? "Review selected source" : "Use an existing project"}
                </Button>
              )}
              {existingSourceOpen && (
                <section aria-label="Existing assignment source">
                  <ExistingProjectPicker
                    actorId={setup.session.userId}
                    active={!busy && !formNavigation.locked}
                    source
                    {...(sourceObserved !== null &&
                    historicalBlankSource(sourceObserved) &&
                    blankSourceProject(sourceObserved)
                      ? { projectId: blankSourceProject(sourceObserved)!.projectId }
                      : {})}
                    onSelect={async (project) => {
                      const record = await selectExistingSource(
                        localStorage,
                        setup.session.userId,
                        sourceObserved,
                        project,
                        () => verifyExistingSelection(setup.session.userId),
                      );
                      setSourceObserved(record);
                      setRecoveredSource(project);
                      setManualSource(true);
                      setExistingSourceOpen(false);
                      setSourceUncertain(null);
                    }}
                    {...(sourceObserved !== null
                      ? {
                          onSeparate: async () => {
                            await verifyExistingSelection(setup.session.userId);
                            if (
                              !(await clearBlankSource(localStorage, setup.session.userId, {
                                record: sourceObserved,
                              }))
                            )
                              throw new Error(
                                "The saved source changed in another tab. Review recovery again.",
                              );
                            setSourceObserved(null);
                            setRecoveredSource(null);
                            setManualSource(false);
                            setExistingSourceOpen(false);
                            setSourceUncertain(null);
                          },
                        }
                      : {})}
                  />
                </section>
              )}
            </>
          ) : null;
        })()}
      {createBlank && !pending && !recoveredSource && (
        <PendingCreateRecovery
          actorId={setup.session.userId}
          purpose="assignment-source"
          historicalLocal={(() => {
            try {
              const record = localStorage.getItem(blankSourceKey(setup.session.userId));
              return (
                record !== null &&
                (historicalBlankSource(record) ||
                  selectedExistingSource(record, setup.session.userId) !== null)
              );
            } catch {
              return false;
            }
          })()}
          active={!busy && !formNavigation.locked}
          refreshKey={sourceUncertain?.record ?? ""}
          prepareRecovered={async (value, operationId, observed, signal) => {
            const before = await assignmentSession();
            if (before.userId !== setup.session.userId || before.mustChangePassword)
              throw new Error("The account changed. Reload before continuing.");
            const projects = await workspace.projects(false, signal, setup.session.userId);
            const current = projects.find(
              (project) => project.projectId === value.id && project.permissions.canManage,
            );
            const after = await assignmentSession();
            if (after.userId !== setup.session.userId || after.mustChangePassword || !current)
              throw new Error(
                "The recovered project is no longer manageable. Refresh before choosing a source.",
              );
            await adoptBlankSource(
              localStorage,
              setup.session.userId,
              observed,
              operationId,
              value.receipt,
              { projectId: current.projectId, title: current.title, revision: current.revision },
              signal,
            );
            return {
              id: current.projectId,
              name: current.title,
              revision: current.revision,
              receipt: value.receipt,
            };
          }}
          onReleased={() => setSourceUncertain(null)}
          onRecovered={(value) => {
            setRecoveredSource({
              projectId: value.id,
              title: value.name,
              revision: value.revision!,
            });
            setSourceUncertain(null);
          }}
        />
      )}
      {recoveredSource && manualSource && (
        <p role="status">
          Using selected existing source project: {recoveredSource.title} (
          {recoveredSource.projectId}), revision {recoveredSource.revision}.
        </p>
      )}
      {recoveredSource && !manualSource && (
        <p role="status">
          Using explicitly recovered source project: {recoveredSource.title}. Submit the assignment
          details to assign this source.
        </p>
      )}
      {sourceUncertain && !pending && (
        <div role="alert" className="sp-creation-notice">
          <p>
            {sourceUncertain.reason === "historical"
              ? "An earlier source creation had no server operation identifier. Review the current projects and choose an exact existing source; a matching name does not identify the earlier result."
              : sourceUncertain.reason === "existing"
                ? "The selected source changed, was removed, or is no longer manageable. Review the current exact project before using it; no replacement source was created."
                : sourceUncertain.reason === "adopted"
                  ? "The recovered source is preserved in this browser. Confirm its acknowledgement in recovery; the original image is not required. Continue with this source after recovery is confirmed."
                  : sourceUncertain.reason === "retry"
                    ? "An earlier project creation needs confirmation. Enter its same title and image, then create again to safely recover the original project."
                    : sourceUncertain.reason === "image"
                      ? "A previously created project has a different image. Starting another project keeps the earlier one in your projects."
                      : sourceUncertain.reason === "unavailable"
                        ? "The project is no longer available or cannot be managed. You can start a new project without losing these details."
                        : "Creating the project could not be confirmed. Check your projects before trying again to avoid creating a duplicate."}
          </p>
          {!["adopted", "historical", "existing"].includes(sourceUncertain.reason) &&
            !existingSourceOpen && (
              <Button
                disabled={busy}
                onClick={async () => {
                  if (inFlight.current) return;
                  inFlight.current = true;
                  setBusy(true);
                  try {
                    if (
                      !(await clearBlankSource(localStorage, setup.session.userId, {
                        record: sourceUncertain.record,
                      }))
                    ) {
                      setMessage(
                        "The saved source changed in another tab. Reload and check your projects.",
                      );
                      return;
                    }
                    if (sourceUncertain.reason !== "unknown") setSourceUncertain(null);
                    else location.assign("/home");
                  } catch {
                    setMessage(
                      "The recovery warning could not be cleared. Your project may still exist.",
                    );
                  } finally {
                    inFlight.current = false;
                    setBusy(false);
                  }
                }}
              >
                {sourceUncertain.reason !== "unknown"
                  ? "Start a new project"
                  : "I checked my projects"}
              </Button>
            )}
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
            organizationName={setup.session.orgName ?? "Selected class's organisation"}
            creatorName={setup.session.userName ? `@${setup.session.userName}` : "Unavailable"}
            initialClassId={initialClass}
            classes={setup.classes}
            students={students}
            showImageOptions={createBlank && !recoveredSource}
            dateOnly={createBlank}
            onClassChange={(classId) => changeClass(classId, setup.session.userId)}
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
  const [result, setResult] = useState<{
    key: string;
    details: AssignmentDetails | null;
  } | null>(null);
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
  onOpenAssignment,
}: {
  classId: string;
  onOpenProject?: (projectId: string) => void;
  studentNames?: Record<string, string>;
  ownProject?: boolean;
  onOpenAssignment?: (assignmentId: string) => void;
}) {
  const [result, setResult] = useState<{
    classId: string;
    items: AssignmentDetails[] | null;
  } | null>(null);
  const [selected, setSelected] = useState<{
    classId: string;
    assignmentId: string;
  } | null>(null);
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
  if (onOpenAssignment)
    return (
      <section aria-label="Class assignments" className="sp-organisation-projects">
        <h2>Class Projects</h2>
        <Table caption="Projects in this class" headings={["Project", "Due Date", "Actions"]}>
          {result.items.map((item) => (
            <tr key={item.assignmentId}>
              <th scope="row">{item.title}</th>
              <td title={formatLocalDeadline(item.dueAtUnixSeconds) ?? "Unavailable"}>
                {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(
                  new Date(item.dueAtUnixSeconds * 1000),
                )}
              </td>
              <td>
                <Button onClick={() => onOpenAssignment(item.assignmentId)}>View Details</Button>
              </td>
            </tr>
          ))}
        </Table>
      </section>
    );

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
