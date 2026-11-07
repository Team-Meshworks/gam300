import { useEffect, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { allPages, createReviewClient } from "../reviews/review-client";
import { ProgressReviews } from "../reviews/ProgressReviews";
import type { LeaveGuard } from "../reviews/ReviewWorkspace";
import { listAssignments, type AssignmentDetails } from "../projects/assignment-api";
import { formatLocalDeadline } from "../projects/deadline";
import { progressEditorUrl, type ProgressContext } from "../projects/progress-navigation";
import { createWorkspaceClient, type ProjectSummary } from "./workspace-api";
import { ProjectHome } from "./ProjectHome";
import "../reviews/reviews.css";

const reviews = createReviewClient();
const workspace = createWorkspaceClient();
type Item = { classId: string; className: string; details: AssignmentDetails };

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
}: {
  item: Item;
  onBack: () => void;
  onProgress: (context: ProgressContext) => void;
}) {
  const [search, setSearch] = useState("");
  const { details } = item;
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
      <div className="sp-teacher-columns">
        <div className="sp-teacher-info">
          <h2>{details.title}</h2>
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
          <h3>All Students ({details.projects.length})</h3>
          {details.projects
            .filter((p) =>
              (p.studentName ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            )
            .map((p) => (
              <div className="sp-teacher-student" key={p.projectId}>
                <strong>{p.studentName ?? "Student name unavailable"}</strong>
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
          {!details.projects.length && <p>No student projects are available.</p>}
        </div>
      </div>
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
          rows.flatMap((row) => row.details.projects.map((project) => project.projectId)),
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
  return (
    <>
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
            history.replaceState(null, "", "/home");
          }}
        />
      )}
    </>
  );
}
