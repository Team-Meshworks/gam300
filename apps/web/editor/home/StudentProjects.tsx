import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { Tabs } from "../../shared/ui/Tabs";
import { listAssignments } from "../projects/assignment-api";
import { formatLocalDeadline } from "../projects/deadline";
import { allPages, createReviewClient } from "../reviews/review-client";
import type { Decision } from "../reviews/review-types";
import { createWorkspaceClient } from "./workspace-api";
import { studentProjectRows, type StudentProjectRow } from "./student-projects";
import { loadStudentFeedback } from "./student-feedback";
import { ProjectHome } from "./ProjectHome";
import "./student-projects.css";

const workspace = createWorkspaceClient();
const accounts = createAccountClient();
const reviews = createReviewClient();

export function StudentProjectDetails({
  row,
  feedback,
  feedbackLoading,
  feedbackError,
  onClose,
  onOpen,
}: {
  row: StudentProjectRow;
  feedback: readonly Decision[];
  feedbackLoading: boolean;
  feedbackError: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  return (
    <section className="sp-student-detail" aria-label="Project details">
      <div className="sp-student-detail-image" aria-label="Project image unavailable" />
      <div className="sp-student-detail-content">
        <div className="sp-student-detail-heading">
          <h1>{row.project.title}</h1>
          <Button aria-label="Close project details" autoFocus onClick={onClose}>
            ×
          </Button>
        </div>
        {row.assignment && (
          <>
            <p className="sp-student-meta">
              {row.assignment.className} · Due{" "}
              {formatLocalDeadline(row.assignment.details.dueAtUnixSeconds) ?? "Unavailable"}
            </p>
            <h2>Project Description:</h2>
            <p>{row.assignment.details.description}</p>
            <h2>Project Instructions:</h2>
            <p>{row.assignment.details.instructions}</p>
          </>
        )}
        {!row.assignment && <p>Assignment details are not available for this project.</p>}
        <h2>Comments:</h2>
        <div className="sp-student-comments">
          {feedbackLoading && <p role="status">Loading feedback…</p>}
          {feedbackError && <p role="alert">{feedbackError}</p>}
          {!feedbackLoading && !feedbackError && !feedback.length && (
            <p>No feedback has been recorded yet.</p>
          )}
          {feedback.map((decision) => (
            <article key={decision.id}>
              <time dateTime={decision.decidedAt}>
                {new Date(decision.decidedAt).toLocaleDateString()}
              </time>
              <p>{decision.feedback}</p>
            </article>
          ))}
        </div>
        <div className="sp-student-detail-actions">
          <Button
            variant="primary"
            disabled={!row.project.permissions.canEdit || row.project.archived}
            onClick={onOpen}
          >
            {row.project.revision === 0 ? "Start Editing" : "Open project"}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function StudentProjects({
  session,
  active,
  onOpenProject,
}: {
  session: AccountSession;
  active: boolean;
  onOpenProject: (projectId: string) => void;
}) {
  const [tab, setTab] = useState<"projects" | "published">("projects");
  const [rows, setRows] = useState<StudentProjectRow[] | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<StudentProjectRow | null>(null);
  const [feedback, setFeedback] = useState<Decision[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [manage, setManage] = useState(false);
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!selected && lastSelected.current) {
      document.getElementById(`student-project-${lastSelected.current}`)?.focus();
      lastSelected.current = null;
    }
  }, [selected]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const [projects, classes] = await Promise.all([
          workspace.projects(false, controller.signal),
          allPages((cursor) => reviews.classrooms(cursor)),
        ]);
        const assignments = (
          await Promise.all(
            classes.map(async (item) =>
              (await listAssignments(item.id, controller.signal)).map((details) => ({
                className: item.name,
                details,
              })),
            ),
          )
        ).flat();
        const current = await accounts.getSession();
        if (
          !current ||
          current.userId !== session.userId ||
          current.orgId !== session.orgId ||
          current.role !== session.role ||
          current.mustChangePassword
        )
          throw new Error("Your account changed.");
        if (!disposed) {
          setRows(studentProjectRows(session.userId, projects, assignments));
          setError("");
        }
      } catch {
        if (!disposed) {
          setRows(null);
          setError("Your projects could not be loaded. Try again.");
        }
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [session.userId, session.orgId, session.role, version]);
  useEffect(() => {
    let disposed = false;
    if (!selected?.assignment) return;
    void (async () => {
      try {
        const decisions = await loadStudentFeedback(
          reviews,
          selected.project.projectId,
          session.userId,
        );
        if (!disposed) setFeedback(decisions);
      } catch {
        if (!disposed) setFeedbackError("Feedback could not be loaded.");
      } finally {
        if (!disposed) setFeedbackLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [selected, session.userId]);
  return (
    <>
      {selected ? (
        <StudentProjectDetails
          row={selected}
          feedback={feedback}
          feedbackLoading={feedbackLoading}
          feedbackError={feedbackError}
          onClose={() => setSelected(null)}
          onOpen={() => onOpenProject(selected.project.projectId)}
        />
      ) : (
        <>
          <h1 className="sp-student-welcome">Welcome Back, {session.displayName}</h1>
          <section className="sp-student-dashboard" aria-label="Student projects">
            <Tabs
              id="student-projects"
              label="Student project views"
              value={tab}
              items={[
                { value: "projects", label: "Projects" },
                { value: "published", label: "Published" },
              ]}
              onChange={setTab}
            />
            <div
              id="student-projects-panel"
              role="tabpanel"
              aria-labelledby={`student-projects-${tab}`}
            >
              {tab === "published" ? (
                <p role="status">
                  Published projects cannot be listed yet. Open publishing from a project to see its
                  current sharing options.
                </p>
              ) : (
                <>
                  {error && (
                    <div role="alert">
                      <p>{error}</p>
                      <Button
                        onClick={() => {
                          setError("");
                          setVersion((n) => n + 1);
                        }}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                  {!rows && !error && <p role="status">Loading projects…</p>}
                  {rows && !rows.length && <p>No projects are available yet.</p>}
                  <div className="sp-student-list">
                    {rows?.map((row) => (
                      <button
                        className="sp-student-card"
                        type="button"
                        id={`student-project-${row.project.projectId}`}
                        key={row.project.projectId}
                        onClick={() => {
                          lastSelected.current = row.project.projectId;
                          setFeedback([]);
                          setFeedbackError("");
                          setFeedbackLoading(Boolean(row.assignment));
                          setSelected(row);
                        }}
                      >
                        <span className="sp-student-card-image" aria-hidden="true" />
                        <span className="sp-student-card-copy">
                          <strong>{row.project.title}</strong>
                          {row.assignment && (
                            <>
                              <small>
                                {row.assignment.className} · Due{" "}
                                {formatLocalDeadline(row.assignment.details.dueAtUnixSeconds) ??
                                  "Unavailable"}
                              </small>
                              <span>{row.assignment.details.description}</span>
                            </>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <details onToggle={(event) => setManage(event.currentTarget.open)}>
              <summary>Manage projects and archives</summary>
              {manage && (
                <ProjectHome session={session} active={active} onOpenProject={onOpenProject} />
              )}
            </details>
          </section>
        </>
      )}
    </>
  );
}
