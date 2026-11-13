import { Icon } from "@iconify/react/offline";
import { SkeletonBox } from "skullet/react";
import commentIcon from "@iconify-icons/lucide/message-square";
import selectIcon from "@iconify-icons/lucide/square-check";
import closeIcon from "@iconify-icons/lucide/x";
import pencilIcon from "@iconify-icons/lucide/pencil-line";
import checkIcon from "@iconify-icons/lucide/circle-check";
import pendingIcon from "@iconify-icons/lucide/clock-3";
import rejectedIcon from "@iconify-icons/lucide/circle-alert";
import globeIcon from "@iconify-icons/lucide/globe";
import lockIcon from "@iconify-icons/lucide/lock-keyhole";
import { Avatar } from "../../shared/ui/Avatar";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { allPages, createReviewClient } from "../reviews/review-client";
import { loadStudentFeedback } from "./student-feedback";
import type { Decision } from "../reviews/review-types";
import { ProgressReviews } from "../reviews/ProgressReviews";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import {
  assignmentSession,
  listAssignments,
  readAssignment,
  type AssignmentDetails,
} from "../projects/assignment-api";
import { AssignmentEditDialog } from "../projects/AssignmentEditDialog";
import { formatDueDate } from "../projects/deadline";
import { progressEditorUrl, type ProgressContext } from "../projects/progress-navigation";
import { createWorkspaceClient, type ProjectSummary } from "./workspace-api";
import { createAccountClient } from "../accounts/account-client";
import { assignmentProgress, projectCover, type RenderWorkspace } from "./dashboard";
import { TeacherDashboard, type TeacherCard, type TeacherQuery } from "./TeacherDashboard";
import "../reviews/reviews.css";
import "./facilitator.css";
import { createDashboardClient, type ProjectPublicationState } from "../admin/dashboard-client";
import { ProjectModeration } from "../admin/ProjectModeration";

const accounts = createAccountClient();
const reviews = createReviewClient();
const workspace = createWorkspaceClient();
type Item = { classId: string; className: string; details: AssignmentDetails };

function updateAssignment(item: Item, classId: string, details: AssignmentDetails): Item {
  return item.classId === classId && item.details.assignmentId === details.assignmentId
    ? { ...item, details }
    : item;
}

export function TeacherStandaloneDetails({
  project,
  onBack,
  onOpen,
}: {
  project: ProjectSummary;
  onBack: () => void;
  onOpen: () => void;
}) {
  return (
    <section className="sp-teacher-detail">
      <div className="sp-teacher-detail-head">
        <div>
          <h1>Project details</h1>
          <h2>{project.title}</h2>
        </div>
        <Button className="sp-close-button" aria-label="Close project details" onClick={onBack}>
          <Icon icon={closeIcon} aria-hidden="true" />
        </Button>
      </div>
      <p>Student assignments are not available from this project view.</p>
      <Button disabled={!project.permissions.canEdit || project.archived} onClick={onOpen}>
        Open project
      </Button>
    </section>
  );
}

export function TeacherProjectDetails({
  item,
  onBack,
  onProgress,
  actorId,
  onUpdated,
  onRemoved,
}: {
  item: Item;
  onBack: () => void;
  onProgress: (context: ProgressContext) => void;
  actorId?: string;
  onUpdated?: (details: AssignmentDetails) => void;
  onRemoved?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [openingProject, setOpeningProject] = useState<string | null>(null);
  const [viewError, setViewError] = useState("");
  const [selectingProjects, setSelectingProjects] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [reviewHistory, setReviewHistory] = useState<{
    projectId: string;
    revision: number;
    decisions: Decision[];
  } | null>(null);
  const [reviewHistoryError, setReviewHistoryError] = useState("");
  async function openReviews(projectId: string, studentId: string) {
    setReviewHistoryError("");
    try {
      const project = await workspace.read(`/api/v1/projects/${encodeURIComponent(projectId)}`);
      if (
        !project ||
        typeof project !== "object" ||
        !("revision" in project) ||
        typeof project.revision !== "number"
      )
        throw new Error("Invalid project");
      const identity = await accounts.getSession();
      if (
        !identity ||
        identity.userId !== actorId ||
        identity.role !== "Educator" ||
        identity.mustChangePassword
      )
        throw new Error("Your account changed. Reload before continuing.");
      const decisions = await loadStudentFeedback(reviews, projectId, studentId);
      setReviewHistory({ projectId, revision: project.revision, decisions });
    } catch {
      setReviewHistoryError("Reviews could not be opened. Try again.");
    }
  }
  const [studentTab, setStudentTab] = useState<"all" | "progress" | "awaiting">("all");
  const [editing, setEditing] = useState<"dueDate" | "description" | "instructions" | null>(null);
  const [editError, setEditError] = useState("");
  const { details } = item;
  const dueDate =
    formatDueDate(details.dueAtUnixSeconds) === null
      ? null
      : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(
          new Date(details.dueAtUnixSeconds * 1000),
        );
  const moderation = useMemo(
    () => createDashboardClient(actorId ?? "", fetch, "facilitator"),
    [actorId],
  );
  const [publicationStates, setPublicationStates] = useState<
    Record<string, ProjectPublicationState>
  >({});
  const [moderationError, setModerationError] = useState("");
  const [moderationAttempt, setModerationAttempt] = useState(0);
  function publicationChanged(state: ProjectPublicationState) {
    setPublicationStates((current) => ({
      ...current,
      [state.projectId.toLowerCase()]: state,
    }));
  }
  async function refreshAssignment() {
    if (!onUpdated) return;
    try {
      const latest = await readAssignment(item.classId, details.assignmentId);
      const identity = await assignmentSession();
      if (
        identity.userId !== actorId ||
        identity.role !== "Educator" ||
        identity.mustChangePassword
      )
        throw new Error("Account changed");
      if (!latest.projects.length) {
        onRemoved?.();
        onBack();
      } else onUpdated(latest);
      setEditError("");
    } catch {
      setEditError(
        "Publication visibility was checked, but the latest approval status could not be loaded. Refresh this page.",
      );
    }
  }
  useEffect(() => {
    if (!actorId) return;
    let disposed = false;
    void moderation
      .publicationStates(details.projects.map((project) => project.projectId))
      .then((states) => {
        if (!disposed) {
          setPublicationStates(states);
          setModerationError("");
        }
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setModerationError(
            cause instanceof Error ? cause.message : "Publication visibility could not be loaded.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [moderation, actorId, details.projects, moderationAttempt]);
  async function viewProject(project: AssignmentDetails["projects"][number]) {
    if (!actorId || openingProject) return;
    setOpeningProject(project.projectId);
    setViewError("");
    const context = {
      classId: item.classId,
      assignmentId: details.assignmentId,
      studentId: project.studentId,
      projectId: project.projectId,
    };
    try {
      const states = await moderation.publicationStates([project.projectId]);
      if (states[project.projectId.toLowerCase()]!.publicationCount > 0) {
        const destination = new URL(progressEditorUrl(context), location.origin);
        destination.searchParams.set("view", "published");
        location.assign(destination.pathname + destination.search);
      } else onProgress(context);
    } catch {
      setViewError("This project could not be opened. Try View again.");
    } finally {
      setOpeningProject(null);
    }
  }
  const labels = {
    "not-submitted": "Not submitted",
    "awaiting-approval": "Awaiting approval",
    approved: "Approved",
    returned: "Changes requested",
    revoked: "Approval revoked",
    "changes-since-submission": "Changes since submission",
  } as const;
  const visibleStudents = details.projects.filter(
    (project) =>
      `${project.studentName ?? ""} ${project.studentUserName ?? ""}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()) &&
      (studentTab === "all" ||
        (studentTab === "awaiting"
          ? project.approvalStatus === "awaiting-approval"
          : project.approvalStatus !== undefined &&
            project.approvalStatus !== "approved" &&
            project.approvalStatus !== "awaiting-approval")),
  );
  const editControl = editing && actorId && (
    <AssignmentEditDialog
      inline
      field={editing}
      classId={item.classId}
      actorId={actorId}
      details={details}
      onClose={() => setEditing(null)}
      onSaved={() => {
        setEditing(null);
        void (async () => {
          try {
            const latest = await readAssignment(item.classId, details.assignmentId);
            const identity = await assignmentSession();
            if (
              identity.userId !== actorId ||
              identity.mustChangePassword ||
              latest.assignmentId !== details.assignmentId
            )
              throw new Error("Account changed");
            onUpdated?.(latest);
            setEditError("");
          } catch {
            setEditError(
              "Changes were saved, but the latest details could not be loaded. Refresh this page.",
            );
          }
        })();
      }}
    />
  );
  const publicProjects = details.projects.map((project) =>
    publicationStates[project.projectId.toLowerCase()]?.publicCount !== undefined
      ? publicationStates[project.projectId.toLowerCase()]!.publicCount > 0
      : project.isPublic,
  );
  const projectStatus = publicProjects.some(Boolean)
    ? "Public"
    : publicProjects.every((value) => value === false)
      ? "Private"
      : "Unavailable";
  function aggregateState(ids: string[]): ProjectPublicationState | undefined {
    const states = ids.map((id) => publicationStates[id.toLowerCase()]);
    if (!ids.length || states.some((state) => !state)) return undefined;
    return {
      projectId: details.assignmentId,
      publicationCount: states.reduce((sum, value) => sum + value!.publicationCount, 0),
      hiddenCount: states.reduce((sum, value) => sum + value!.hiddenCount, 0),
      publicCount: states.reduce((sum, value) => sum + value!.publicCount, 0),
      publishingBlocked: states.every((value) => value!.publishingBlocked || value!.removed),
      removed: states.every((value) => value!.removed),
    };
  }
  const assignmentState = aggregateState(details.projects.map((project) => project.projectId));
  const selectableIds = visibleStudents
    .filter((project) => publicationStates[project.projectId.toLowerCase()]?.removed === false)
    .map((project) => project.projectId);
  const selectedIds = selectedProjects.filter((id) => selectableIds.includes(id));
  const allSelected = selectableIds.length > 0 && selectedIds.length === selectableIds.length;
  return (
    <section className="sp-teacher-detail">
      <div className="sp-teacher-detail-head">
        <div>
          <h1>Published Projects</h1>
          <p>Review published experiences and control what visitors can explore.</p>
        </div>
        <Button
          className="sp-close-button"
          aria-label="Close project details"
          disabled={Boolean(editing)}
          onClick={onBack}
        >
          <Icon icon={closeIcon} aria-hidden="true" />
        </Button>
      </div>
      {editError && <p role="alert">{editError}</p>}
      {reviewHistoryError && <p role="alert">{reviewHistoryError}</p>}
      {viewError && <p role="alert">{viewError}</p>}
      {reviewHistory && actorId && (
        <ProgressReviews
          key={reviewHistory.projectId}
          projectId={reviewHistory.projectId}
          revision={reviewHistory.revision}
          decisions={reviewHistory.decisions}
          actorId={actorId}
          educator
          autoOpen
          onGuard={() => {}}
          onClose={() => setReviewHistory(null)}
        />
      )}
      <div className="sp-teacher-columns">
        <div className="sp-teacher-info">
          <div className="sp-teacher-project-identity">
            <img
              className="sp-teacher-detail-cover"
              src={details.image?.url ?? projectCover(details.title)}
              alt=""
            />
            <h2>{details.title}</h2>
          </div>
          {actorId && (
            <div className="sp-teacher-assignment-actions">
              <ProjectModeration
                projectId={details.assignmentId}
                projectIds={details.projects.map((project) => project.projectId)}
                client={moderation}
                state={assignmentState}
                requiresFreshApproval
                onChanged={() => {}}
                onCompleted={async () => {
                  await refreshAssignment();
                  setModerationAttempt((value) => value + 1);
                }}
              />
            </div>
          )}
          <dl className="sp-teacher-metadata">
            {details.organizationName && (
              <>
                <dt>Organisation</dt>
                <dd>
                  <a
                    className="sp-teacher-organisation-link"
                    href={`/classes?organisation=1&classId=${encodeURIComponent(item.classId)}&assignmentId=${encodeURIComponent(details.assignmentId)}`}
                  >
                    {details.organizationName}
                  </a>
                </dd>
              </>
            )}
            {details.creatorName && (
              <>
                <dt>Created by</dt>
                <dd>
                  {details.creatorUserName ? `@${details.creatorUserName}` : "Username unavailable"}
                </dd>
              </>
            )}
            <dt>Class</dt>
            <dd>{item.className}</dd>
            <dt>Status</dt>
            <dd className="sp-teacher-project-status" data-public={projectStatus === "Public"}>
              <Icon icon={projectStatus === "Public" ? globeIcon : lockIcon} aria-hidden="true" />
              {projectStatus}
            </dd>
          </dl>
          <div className="sp-teacher-field-heading">
            <h3>Due Date</h3>
            {actorId && (
              <Button
                disabled={details.revision === undefined || Boolean(editing)}
                onClick={() => setEditing("dueDate")}
                aria-label="Edit Due Date"
              >
                <Icon icon={pencilIcon} aria-hidden="true" />
                <span>Edit</span>
              </Button>
            )}
          </div>
          {editing === "dueDate" ? (
            editControl
          ) : (
            <p className="sp-teacher-value">{dueDate ?? "Unavailable"}</p>
          )}
          <div className="sp-teacher-field-heading">
            <h3>Project Description</h3>
            {actorId && (
              <Button
                disabled={details.revision === undefined || Boolean(editing)}
                onClick={() => setEditing("description")}
                aria-label="Edit Project Description"
              >
                <Icon icon={pencilIcon} aria-hidden="true" />
                <span>Edit</span>
              </Button>
            )}
          </div>
          {editing === "description" ? (
            editControl
          ) : (
            <p className="sp-teacher-value">{details.description}</p>
          )}
          <div className="sp-teacher-field-heading">
            <h3>Project Instructions</h3>
            {actorId && (
              <Button
                disabled={details.revision === undefined || Boolean(editing)}
                onClick={() => setEditing("instructions")}
                aria-label="Edit Project Instructions"
              >
                <Icon icon={pencilIcon} aria-hidden="true" />
                <span>Edit</span>
              </Button>
            )}
          </div>
          {editing === "instructions" ? (
            editControl
          ) : (
            <p className="sp-teacher-value">{details.instructions}</p>
          )}
        </div>
        <div className="sp-teacher-students">
          {moderationError && (
            <div role="alert">
              <p>{moderationError}</p>
              <Button onClick={() => setModerationAttempt((value) => value + 1)}>
                Retry publication controls
              </Button>
            </div>
          )}
          <SearchField
            label="Search students"
            placeholder="Search students by name or account"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setSelectedProjects([]);
            }}
          />
          <div className="sp-teacher-student-toolbar">
            {selectingProjects ? (
              <div
                className="sp-teacher-project-selection"
                role="group"
                aria-label="Student project selection"
              >
                <label>
                  <input
                    type="checkbox"
                    aria-label="Select all visible projects"
                    checked={allSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = selectedIds.length > 0 && !allSelected;
                    }}
                    onChange={() => setSelectedProjects(allSelected ? [] : selectableIds)}
                  />
                  <span>Select all</span>
                </label>
                <div className="sp-teacher-selection-actions">
                  <Button
                    onClick={() => {
                      setSelectingProjects(false);
                      setSelectedProjects([]);
                    }}
                  >
                    Cancel
                  </Button>
                  <ProjectModeration
                    projectId={details.assignmentId}
                    projectIds={selectedIds}
                    client={moderation}
                    state={aggregateState(selectedIds)}
                    selection
                    requiresFreshApproval
                    onChanged={() => {}}
                    onCompleted={async () => {
                      const states = await moderation.publicationStates(selectedIds);
                      await refreshAssignment();
                      setPublicationStates((current) => ({ ...current, ...states }));
                      if (selectedIds.every((id) => states[id.toLowerCase()]!.removed)) {
                        setSelectingProjects(false);
                        setSelectedProjects([]);
                      }
                    }}
                  />
                </div>
              </div>
            ) : (
              <>
                <Tabs
                  id="teacher-student-status"
                  label="Student project status"
                  value={studentTab}
                  onChange={(value) => {
                    setStudentTab(value);
                    setSelectedProjects([]);
                  }}
                  items={[
                    { value: "all", label: "All Students" },
                    { value: "progress", label: "In Progress" },
                    { value: "awaiting", label: "Awaiting Approval" },
                  ]}
                />
                {actorId && (
                  <Button
                    className="sp-teacher-select-projects"
                    aria-label="Select student projects"
                    title="Select student projects"
                    disabled={!selectableIds.length}
                    onClick={() => setSelectingProjects(true)}
                  >
                    <Icon icon={selectIcon} aria-hidden="true" />
                  </Button>
                )}
              </>
            )}
          </div>
          <div
            className="sp-teacher-student-list"
            id="teacher-student-status-panel"
            role="tabpanel"
            aria-labelledby={`teacher-student-status-${studentTab}`}
          >
            {visibleStudents.map((p) => (
              <div className="sp-teacher-student" key={p.projectId}>
                <div className="sp-teacher-student-identity">
                  {selectingProjects && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.studentName ?? "student"}'s project`}
                      disabled={!selectableIds.includes(p.projectId)}
                      checked={selectedIds.includes(p.projectId)}
                      onChange={(event) =>
                        setSelectedProjects((current) =>
                          event.target.checked
                            ? [...current, p.projectId]
                            : current.filter((id) => id !== p.projectId),
                        )
                      }
                    />
                  )}
                  <Avatar name={p.studentName ?? "Student"} />
                  <div>
                    <strong>{p.studentName ?? "Student name unavailable"}</strong>
                    {p.studentUserName && (
                      <span className="sp-teacher-student-handle">@{p.studentUserName}</span>
                    )}
                  </div>
                </div>
                <div className="sp-teacher-student-status">
                  <p>
                    <span>Approval status</span>
                    <strong data-approval={p.approvalStatus}>
                      <Icon
                        icon={
                          p.approvalStatus === "approved"
                            ? checkIcon
                            : p.approvalStatus === "awaiting-approval"
                              ? pendingIcon
                              : rejectedIcon
                        }
                        aria-hidden="true"
                      />
                      <span
                        title={
                          p.approvalStatus
                            ? labels[p.approvalStatus]
                            : "Approval status unavailable"
                        }
                      >
                        {p.approvalStatus
                          ? p.approvalStatus === "approved"
                            ? "Approved"
                            : "Not Approved"
                          : "Unavailable"}
                      </span>
                    </strong>
                  </p>
                  <p>
                    <span>Publish Status</span>
                    <strong
                      className="sp-teacher-publish-status"
                      data-public={
                        (publicationStates[p.projectId.toLowerCase()]?.publicCount ??
                          (p.isPublic ? 1 : 0)) > 0
                      }
                    >
                      <Icon
                        icon={
                          (publicationStates[p.projectId.toLowerCase()]?.publicCount ??
                            (p.isPublic ? 1 : 0)) > 0
                            ? globeIcon
                            : lockIcon
                        }
                        aria-hidden="true"
                      />
                      {publicationStates[p.projectId.toLowerCase()]
                        ? publicationStates[p.projectId.toLowerCase()]!.publicCount > 0
                          ? "Public"
                          : "Private"
                        : p.isPublic === undefined
                          ? "Unavailable"
                          : p.isPublic
                            ? "Public"
                            : "Private"}
                    </strong>
                  </p>
                </div>
                <div className="sp-teacher-student-actions">
                  <Button
                    variant="primary"
                    disabled={!p.studentName || openingProject !== null}
                    onClick={() => void viewProject(p)}
                  >
                    {(publicationStates[p.projectId.toLowerCase()]?.publicationCount ??
                      (p.published ? 1 : 0)) > 0
                      ? "View Exhibition"
                      : "Review Project"}
                  </Button>
                  {actorId && (
                    <Button
                      className="sp-teacher-review-history"
                      aria-label="Reviews"
                      title="Read or add saved reviews for this student"
                      onClick={() => void openReviews(p.projectId, p.studentId)}
                    >
                      <Icon icon={commentIcon} aria-hidden="true" />
                    </Button>
                  )}
                  {actorId && (
                    <ProjectModeration
                      projectId={p.projectId}
                      client={moderation}
                      state={publicationStates[p.projectId.toLowerCase()]}
                      onChanged={publicationChanged}
                      onCompleted={() => refreshAssignment()}
                      requiresFreshApproval
                    />
                  )}
                </div>
              </div>
            ))}
            {!visibleStudents.length && (
              <p className="sp-teacher-students-empty" role="status">
                {details.projects.length
                  ? "No student projects match this view."
                  : "No student projects are available."}
              </p>
            )}
          </div>
          <p className="sp-teacher-students-note">
            <Icon icon={lockIcon} aria-hidden="true" />
            Only completed, submitted and teacher-approved work can be published.
          </p>
        </div>
      </div>
    </section>
  );
}

export function TeacherProjects({
  session,
  listVersion,
  renderWorkspace,
}: {
  session: AccountSession;
  listVersion: number;
  renderWorkspace: RenderWorkspace;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [availableClasses, setAvailableClasses] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState<TeacherQuery>({
    classId: "",
    filter: "all",
    search: "",
  });
  const lastSelected = useRef<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [standalone, setStandalone] = useState<ProjectSummary[]>([]);
  const [selectedStandalone, setSelectedStandalone] = useState<ProjectSummary | null>(null);
  const [guard, setGuard] = useState<LeaveGuard>({
    pending: false,
    dirty: false,
  });
  const [showReview, setShowReview] = useState(false);
  const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const [reviewProject, setReviewProject] = useState<{
    projectId: string;
    studentId: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const [classes, projects] = await Promise.all([
          allPages((cursor) => reviews.classrooms(cursor)),
          workspace.projects(false, controller.signal),
        ]);
        const groups = await Promise.all(
          classes.map(async (c) =>
            (await listAssignments(c.id, controller.signal)).map((details) => ({
              classId: c.id,
              className: c.name,
              details,
            })),
          ),
        );
        const current = await accounts.getSession();
        if (
          !current ||
          current.userId !== session.userId ||
          current.orgId !== session.orgId ||
          current.role !== session.role ||
          current.mustChangePassword
        )
          throw new Error("Account changed");
        if (disposed) return;
        setAvailableClasses(classes);
        setQuery((current) =>
          !current.classId || classes.some((item) => item.id === current.classId)
            ? current
            : { ...current, classId: "" },
        );
        setError("");
        const rows = groups.flat();
        const assigned = new Set(
          rows.flatMap((row) => [
            ...row.details.projects.map((project) => project.projectId),
            ...(row.details.sourceProjectId ? [row.details.sourceProjectId] : []),
          ]),
        );
        const independent = projects.filter(
          (project) => !project.isClassProject && !assigned.has(project.projectId),
        );
        setStandalone(independent);
        setItems(rows);
        const query = new URLSearchParams(location.search);
        const found = rows.find(
          (row) =>
            row.classId === query.get("classId") &&
            row.details.assignmentId === query.get("assignmentId"),
        );
        const independentProject = independent.find(
          (project) => project.projectId === query.get("projectId"),
        );
        if (independentProject) setSelectedStandalone(independentProject);
        if (found) {
          setSelected(found);
          const project = found.details.projects.find(
            (p) =>
              p.projectId === query.get("reviewProjectId") &&
              p.studentId === query.get("studentId"),
          );
          if (project) {
            setReviewProject({
              projectId: project.projectId,
              studentId: project.studentId,
              name: project.studentName ?? "Student",
            });
            setShowReview(true);
            try {
              const saved = await reviews.project(project.projectId);
              if (!disposed) setReviewRevision(saved.revision);
            } catch {
              if (!disposed)
                setError("The saved project could not be loaded for review. Refresh to try again.");
            }
          }
        }
      } catch {
        if (!disposed) {
          setItems(null);
          setStandalone([]);
          setError("Projects could not be loaded. Try again.");
        }
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [attempt, listVersion, session.userId, session.orgId, session.role]);
  useEffect(() => {
    if (!selected && !selectedStandalone && lastSelected.current) {
      document.getElementById(`teacher-project-${lastSelected.current}`)?.focus();
      lastSelected.current = null;
    }
  }, [selected, selectedStandalone]);
  function applyAssignment(classId: string, details: AssignmentDetails) {
    setSelected((current) => (current ? updateAssignment(current, classId, details) : null));
    setItems((current) => current?.map((item) => updateAssignment(item, classId, details)) ?? null);
  }
  async function refreshAssignment(item: Item) {
    try {
      const latest = await readAssignment(item.classId, item.details.assignmentId);
      const identity = await assignmentSession();
      if (
        identity.userId !== session.userId ||
        identity.orgId !== session.orgId ||
        identity.role !== session.role ||
        identity.mustChangePassword ||
        latest.assignmentId !== item.details.assignmentId
      )
        throw new Error("Account or assignment changed");
      applyAssignment(item.classId, latest);
    } catch {
      setError("The latest assignment details could not be loaded. Refresh this page.");
    }
  }
  const cards: TeacherCard[] | null = items && [
    ...items.map((item) => {
      const { status, submitted } = assignmentProgress(item.details.projects);
      const id = `${item.classId}:${item.details.assignmentId}`;
      return {
        id,
        title: item.details.title,
        classId: item.classId,
        ...(item.details.image ? { imageUrl: item.details.image.url } : {}),
        status,
        metadata: `${item.className} · ${submitted === null ? "Submission count unavailable" : `${submitted} student submission${submitted === 1 ? "" : "s"}`}`,
        onDetails: () => {
          lastSelected.current = id;
          history.replaceState(
            null,
            "",
            `/home?${new URLSearchParams({
              classId: item.classId,
              assignmentId: item.details.assignmentId,
            })}`,
          );
          setSelected(item);
        },
      };
    }),
    ...standalone.map((project) => ({
      id: project.projectId,
      title: project.title,
      ...(project.image ? { imageUrl: project.image.url } : {}),
      status: "In Progress" as const,
      metadata: "Independent project",
      onDetails: () => {
        lastSelected.current = project.projectId;
        history.replaceState(
          null,
          "",
          `/home?${new URLSearchParams({ projectId: project.projectId })}`,
        );
        setSelectedStandalone(project);
      },
    })),
  ];
  const openingDetails =
    !items &&
    !error &&
    (new URLSearchParams(location.search).has("assignmentId") ||
      new URLSearchParams(location.search).has("projectId"));
  return renderWorkspace(
    <>
      {selected && error && <p role="alert">{error}</p>}
      {openingDetails ? (
        <section
          className="sp-teacher-detail"
          aria-busy="true"
          aria-label="Loading project details"
        >
          <div className="sp-teacher-detail-head">
            <div>
              <h1>Published Projects</h1>
              <p>Review published experiences and control what visitors can explore.</p>
            </div>
          </div>
          <div className="sp-teacher-columns" aria-hidden="true">
            <div className="sp-teacher-info">
              <SkeletonBox width="100%" height={102} radius={16} />
              <SkeletonBox width="70%" height={20} radius={6} />
              <SkeletonBox width="100%" height={180} radius={12} />
            </div>
            <SkeletonBox width="100%" height={300} radius={16} />
          </div>
        </section>
      ) : selectedStandalone ? (
        <TeacherStandaloneDetails
          project={selectedStandalone}
          onBack={() => {
            setSelectedStandalone(null);
            history.replaceState(null, "", "/home");
          }}
          onOpen={() =>
            location.assign(`/?projectId=${encodeURIComponent(selectedStandalone.projectId)}`)
          }
        />
      ) : selected ? (
        <TeacherProjectDetails
          item={selected}
          actorId={session.userId}
          onUpdated={(details) => applyAssignment(selected.classId, details)}
          onRemoved={() => {
            setItems(
              (current) =>
                current?.filter(
                  (item) => item.details.assignmentId !== selected.details.assignmentId,
                ) ?? null,
            );
            setAttempt((value) => value + 1);
          }}
          onBack={() => {
            if (guard.pending || (guard.dirty && !window.confirm("Discard your unsaved feedback?")))
              return;
            setSelected(null);
            history.replaceState(null, "", "/home");
          }}
          onProgress={(context) => location.assign(progressEditorUrl(context))}
        />
      ) : (
        <TeacherDashboard
          classes={availableClasses}
          name={session.displayName}
          cards={cards}
          error={error}
          query={query}
          onQuery={setQuery}
          onRetry={() => {
            setError("");
            setAttempt((value) => value + 1);
          }}
        />
      )}
      {showReview &&
        reviewRevision === null &&
        (error ? <p role="alert">{error}</p> : <p role="status">Loading reviews…</p>)}
      {showReview && reviewProject && selected && reviewRevision !== null && (
        <ProgressReviews
          projectId={reviewProject.projectId}
          revision={reviewRevision}
          actorId={session.userId}
          orgId={session.orgId}
          educator
          autoOpen
          publication={{
            studentId: reviewProject.studentId,
            studentName: reviewProject.name,
            projectTitle: selected.details.title,
            className: selected.className,
          }}
          onGuard={setGuard}
          onClose={() => {
            setShowReview(false);
            void refreshAssignment(selected);
            history.replaceState(null, "", "/home");
          }}
        />
      )}
    </>,
    openingDetails || selected || selectedStandalone ? "facilitator-details" : "facilitator",
  );
}
