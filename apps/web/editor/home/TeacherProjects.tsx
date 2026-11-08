import { useEffect, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { allPages, createReviewClient } from "../reviews/review-client";
import { ProgressReviews } from "../reviews/ProgressReviews";
import type { LeaveGuard } from "../reviews/ReviewWorkspace";
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
import { ProjectHome } from "./ProjectHome";
import "../reviews/reviews.css";

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

export function TeacherProjects({ session, active }: { session: AccountSession; active: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [standalone, setStandalone] = useState<ProjectSummary[]>([]);
  const [selectedStandalone, setSelectedStandalone] = useState<ProjectSummary | null>(null);
  const [manage, setManage] = useState(false);
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
    void (async () => {
      try {
        const [classes, projects] = await Promise.all([
          allPages((cursor) => reviews.classrooms(cursor)),
          workspace.projects(false),
        ]);
        const groups = await Promise.all(
          classes.map(async (c) =>
            (await listAssignments(c.id)).map((details) => ({
              classId: c.id,
              className: c.name,
              details,
            })),
          ),
        );
        if (disposed) return;
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
        if (!disposed) setError("Projects could not be loaded. Refresh to try again.");
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
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
  return (
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
        <>
          <div className="sp-teacher-welcome">
            <h1>Welcome Back, {session.displayName}</h1>
            <p>A space to spark ideas, guide student work and curate what gets shared.</p>
          </div>
          <section className="sp-teacher-projects">
            <div className="sp-teacher-heading">
              <div>
                <h2>All Projects</h2>
                <p>Review projects and student progress.</p>
              </div>
              <SearchField
                label="Search projects"
                placeholder="Search all projects"
                value={search}
                onChange={setSearch}
              />
            </div>
            <div className="sp-teacher-toolbar">
              <strong>All Projects ({(items?.length ?? 0) + standalone.length})</strong>
              <a className="sp-button sp-button--primary" href="/new-project">
                + New Project
              </a>
            </div>
            {error && <p role="alert">{error}</p>}
            {!items && !error && <p role="status">Loading projects…</p>}
            {items && !items.length && !standalone.length && <p>No projects are available yet.</p>}
            <div className="sp-teacher-grid">
              {items
                ?.filter((item) =>
                  item.details.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
                )
                .map((item) => (
                  <article
                    className="sp-teacher-card"
                    key={`${item.classId}:${item.details.assignmentId}`}
                  >
                    <div className="sp-teacher-card-cover" />
                    <div>
                      <h3>{item.details.title}</h3>
                      <p>
                        {item.className} · {item.details.projects.length} student projects
                      </p>
                      <Button variant="primary" onClick={() => setSelected(item)}>
                        View Details
                      </Button>
                    </div>
                  </article>
                ))}
            </div>
            {standalone.length > 0 && (
              <>
                <h2>Other projects</h2>
                <div className="sp-teacher-grid">
                  {standalone
                    .filter((project) =>
                      project.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
                    )
                    .map((project) => (
                      <article className="sp-teacher-card" key={project.projectId}>
                        <div className="sp-teacher-card-cover" />
                        <div>
                          <h3>{project.title}</h3>
                          <Button variant="primary" onClick={() => setSelectedStandalone(project)}>
                            View Details
                          </Button>
                        </div>
                      </article>
                    ))}
                </div>
              </>
            )}
            <details onToggle={(event) => setManage(event.currentTarget.open)}>
              <summary>Manage projects and archives</summary>
              {manage && (
                <ProjectHome
                  session={session}
                  active={active}
                  showCreation={false}
                  onOpenProject={(projectId) =>
                    location.assign(`/?projectId=${encodeURIComponent(projectId)}`)
                  }
                />
              )}
            </details>
          </section>
        </>
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
    </>
  );
}
