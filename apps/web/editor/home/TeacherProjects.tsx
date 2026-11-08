import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { allPages, createReviewClient } from "../reviews/review-client";
import { ProgressReviews } from "../reviews/ProgressReviews";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import {
  assignmentSession,
  listAssignments,
  readAssignment,
  type AssignmentDetails,
} from "../projects/assignment-api";
import { AssignmentEditDialog } from "../projects/AssignmentEditDialog";
import { formatLocalDeadline } from "../projects/deadline";
import { progressEditorUrl, type ProgressContext } from "../projects/progress-navigation";
import { createWorkspaceClient, type ProjectSummary } from "./workspace-api";
import { createAccountClient } from "../accounts/account-client";
import { assignmentProgress, type RenderWorkspace } from "./dashboard";
import { TeacherDashboard, type TeacherCard, type TeacherQuery } from "./TeacherDashboard";
import "../reviews/reviews.css";

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
        <Button aria-label="Close project details" onClick={onBack}>
          ×
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
}: {
  item: Item;
  onBack: () => void;
  onProgress: (context: ProgressContext) => void;
  actorId?: string;
  onUpdated?: (details: AssignmentDetails) => void;
}) {
  const [search, setSearch] = useState("");
  const [studentTab, setStudentTab] = useState<"all" | "progress" | "awaiting">("all");
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState("");
  const { details } = item;
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
      (project.studentName ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
      (studentTab === "all" ||
        (studentTab === "awaiting"
          ? project.approvalStatus === "awaiting-approval"
          : project.approvalStatus !== undefined &&
            project.approvalStatus !== "approved" &&
            project.approvalStatus !== "awaiting-approval")),
  );
  return (
    <section className="sp-teacher-detail">
      <div className="sp-teacher-detail-head">
        <div>
          <h1>Project details</h1>
          <p>Review student projects and their progress.</p>
        </div>
        <Button aria-label="Close project details" onClick={onBack}>
          ×
        </Button>
      </div>
      {editError && <p role="alert">{editError}</p>}
      {actorId && (
        <Button disabled={details.revision === undefined} onClick={() => setEditing(true)}>
          Edit project details
        </Button>
      )}
      <div className="sp-teacher-columns">
        <div className="sp-teacher-info">
          <h2>{details.title}</h2>
          {details.organizationName && <p>Organisation: {details.organizationName}</p>}
          {details.creatorName && <p>Created by: {details.creatorName}</p>}
          <p className="sp-hint">Class {item.className}</p>
          <h3>Due Date</h3>
          <p className="sp-teacher-value">
            {formatLocalDeadline(details.dueAtUnixSeconds) ?? "Unavailable"}
          </p>
          <h3>Project Description</h3>
          <p className="sp-teacher-value">{details.description}</p>
          <h3>Project Instructions</h3>
          <p className="sp-teacher-value">{details.instructions}</p>
        </div>
        <div className="sp-teacher-students">
          <SearchField
            label="Search students"
            placeholder="Search students by name or account"
            value={search}
            onChange={setSearch}
          />
          <Tabs
            id="teacher-student-status"
            label="Student project status"
            value={studentTab}
            onChange={setStudentTab}
            items={[
              { value: "all", label: `All Students (${details.projects.length})` },
              { value: "progress", label: "In Progress" },
              { value: "awaiting", label: "Awaiting Approval" },
            ]}
          />
          {visibleStudents.map((p) => (
            <div className="sp-teacher-student" key={p.projectId}>
              <strong>{p.studentName ?? "Student name unavailable"}</strong>
              <p>Approval status: {p.approvalStatus ? labels[p.approvalStatus] : "Unavailable"}</p>
              <p>
                Publication status:{" "}
                {p.published === undefined
                  ? "Unavailable"
                  : p.published
                    ? "Published"
                    : "Not published"}
              </p>
              <Button
                variant="primary"
                disabled={!p.studentName}
                onClick={() =>
                  onProgress({
                    classId: item.classId,
                    assignmentId: details.assignmentId,
                    studentId: p.studentId,
                    projectId: p.projectId,
                  })
                }
              >
                View Progress
              </Button>
            </div>
          ))}
          {!visibleStudents.length && (
            <p>
              {details.projects.length
                ? "No student projects match this view."
                : "No student projects are available."}
            </p>
          )}
        </div>
      </div>
      {editing && actorId && (
        <AssignmentEditDialog
          classId={item.classId}
          actorId={actorId}
          details={details}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
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
      )}
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
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState<TeacherQuery>({ filter: "all", search: "" });
  const lastSelected = useRef<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [standalone, setStandalone] = useState<ProjectSummary[]>([]);
  const [selectedStandalone, setSelectedStandalone] = useState<ProjectSummary | null>(null);
  const [guard, setGuard] = useState<LeaveGuard>({ pending: false, dirty: false });
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
        setError("");
        const rows = groups.flat();
        const assigned = new Set(
          rows.flatMap((row) => [
            ...row.details.projects.map((project) => project.projectId),
            ...(row.details.sourceProjectId ? [row.details.sourceProjectId] : []),
          ]),
        );
        setStandalone(projects.filter((project) => !assigned.has(project.projectId)));
        setItems(rows);
        const query = new URLSearchParams(location.search);
        const found = rows.find(
          (row) =>
            row.classId === query.get("classId") &&
            row.details.assignmentId === query.get("assignmentId"),
        );
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
        status,
        metadata: `${item.className} · ${submitted === null ? "Submission count unavailable" : `${submitted} student submission${submitted === 1 ? "" : "s"}`}`,
        onDetails: () => {
          lastSelected.current = id;
          setSelected(item);
        },
      };
    }),
    ...standalone.map((project) => ({
      id: project.projectId,
      title: project.title,
      status: "In Progress" as const,
      metadata: "Independent project",
      onDetails: () => {
        lastSelected.current = project.projectId;
        setSelectedStandalone(project);
      },
    })),
  ];
  return renderWorkspace(
    <>
      {selected && error && <p role="alert">{error}</p>}
      {selectedStandalone ? (
        <TeacherStandaloneDetails
          project={selectedStandalone}
          onBack={() => setSelectedStandalone(null)}
          onOpen={() =>
            location.assign(`/?projectId=${encodeURIComponent(selectedStandalone.projectId)}`)
          }
        />
      ) : selected ? (
        <TeacherProjectDetails
          item={selected}
          actorId={session.userId}
          onUpdated={(details) => applyAssignment(selected.classId, details)}
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
    selected || selectedStandalone ? undefined : "facilitator",
  );
}
