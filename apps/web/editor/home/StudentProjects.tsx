import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { Tabs } from "../../shared/ui/Tabs";
import { listAssignments } from "../projects/assignment-api";
import { formatLocalDeadline } from "../projects/deadline";
import { allPages, createReviewClient } from "../reviews/review-client";
import type { Decision } from "../reviews/review-types";
import { ProgressReviews } from "../reviews/ProgressReviews";
import { PublicationShare } from "../publications/PublicationShare";
import { readStudentPublication, type StudentPublication } from "./student-publication";
import "../publications/publication.css";
import "../reviews/reviews.css";
import { createWorkspaceClient } from "./workspace-api";
import { studentProjectRows, type StudentProjectRow } from "./student-projects";
import { loadStudentFeedback } from "./student-feedback";
import { Icon } from "@iconify/react/offline";
import info from "@iconify-icons/lucide/info";
import type { RenderWorkspace } from "./dashboard";
import { DashboardSkeleton } from "./DashboardSkeleton";
import { CreatorProjectCard } from "./CreatorProjectCard";
import { PublishedProjects } from "./PublishedProjects";
import "./student-projects.css";

const workspace = createWorkspaceClient();
const accounts = createAccountClient();
const reviews = createReviewClient();
const ignoreGuard = () => {};

function StudentPublicationLink({ projectId, actorId }: { projectId: string; actorId: string }) {
  const [result, setResult] = useState<{ item: StudentPublication | null; error: string } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readStudentPublication(projectId, actorId, fetch, controller.signal).then(
      (item) => {
        if (!controller.signal.aborted) setResult({ item, error: "" });
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ item: null, error: "The published link could not be loaded." });
      },
    );
    return () => controller.abort();
  }, [projectId, actorId, attempt]);
  if (!result) return <p role="status">Checking for a published project…</p>;
  if (result.error)
    return (
      <div>
        <p role="alert">{result.error}</p>
        <Button
          onClick={() => {
            setResult(null);
            setAttempt((value) => value + 1);
          }}
        >
          Retry published link
        </Button>
      </div>
    );
  return result.item ? (
    <PublicationShare url={result.item.visitorUrl} unlisted />
  ) : (
    <p>This project has not been published yet.</p>
  );
}

export function StudentProjectDetails({
  row,
  feedback,
  feedbackLoading,
  feedbackError,
  actorId,
  onClose,
  onOpen,
}: {
  row: StudentProjectRow;
  feedback: readonly Decision[];
  feedbackLoading: boolean;
  feedbackError: string;
  actorId: string;
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
        <StudentPublicationLink
          key={`link:${row.project.projectId}:${actorId}`}
          projectId={row.project.projectId}
          actorId={actorId}
        />
        {!row.assignment && <p>Assignment details are not available for this project.</p>}
        <h2>Comments:</h2>
        {row.assignment && (
          <ProgressReviews
            key={`${row.project.projectId}:${actorId}`}
            projectId={row.project.projectId}
            revision={row.project.revision}
            actorId={actorId}
            educator={false}
            decisions={feedback}
            decisionsLoading={feedbackLoading}
            decisionsError={feedbackError}
            onGuard={ignoreGuard}
          />
        )}
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
  listVersion,
  renderWorkspace,
  active,
  onOpenProject,
}: {
  session: AccountSession;
  listVersion: number;
  renderWorkspace: RenderWorkspace;
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
  }, [session.userId, session.orgId, session.role, version, listVersion]);
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
  if (selected)
    return renderWorkspace(
      <StudentProjectDetails
        row={selected}
        feedback={feedback}
        feedbackLoading={feedbackLoading}
        feedbackError={feedbackError}
        actorId={session.userId}
        onClose={() => setSelected(null)}
        onOpen={() => onOpenProject(selected.project.projectId)}
      />,
    );
  const published = tab === "published";
  return renderWorkspace(
    <section className="sp-student-dashboard" aria-labelledby="creator-heading" data-tab={tab}>
      <div className="sp-student-heading">
        <h1 id="creator-heading">{published ? "Published Projects" : "Projects"}</h1>
        <p>
          {published
            ? "Your work, ready to explore. View your published projects and share them with others."
            : "Your next chapter starts here. Explore your assigned projects and keep track of approvals."}
        </p>
      </div>
      <Tabs
        id="student-projects"
        label="Project views"
        value={tab}
        items={[
          { value: "projects", label: "Projects" },
          { value: "published", label: "Published" },
        ]}
        onChange={setTab}
      />
      <div id="student-projects-panel" role="tabpanel" aria-labelledby={`student-projects-${tab}`}>
        {error ? (
          <div role="alert" className="sp-dashboard-state">
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
        ) : !rows ? (
          <DashboardSkeleton view={published ? "published" : "creator"} />
        ) : published ? (
          active && <PublishedProjects rows={rows} session={session} />
        ) : !rows.length ? (
          <p className="sp-dashboard-state" role="status">
            No projects are available yet.
          </p>
        ) : (
          <div className="sp-student-list">
            {rows.map((row) => (
              <CreatorProjectCard
                key={row.project.projectId}
                row={row}
                name={session.displayName}
                onOpen={() => onOpenProject(row.project.projectId)}
                onDetails={() => {
                  lastSelected.current = row.project.projectId;
                  setFeedback([]);
                  setFeedbackError("");
                  setFeedbackLoading(Boolean(row.assignment));
                  setSelected(row);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <p className="sp-workspace-note">
        <Icon icon={info} width={16} />
        {published
          ? "A little sharing goes a long way. Copy your project link into a message, email or presentation."
          : "Open a project to review its instructions and continue building your virtual museum."}
      </p>
    </section>,
    published ? "creator-published" : "creator-projects",
  );
}
