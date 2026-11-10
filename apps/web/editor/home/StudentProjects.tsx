import { ProjectImageView } from "./ProjectImageView";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { useModal } from "../../shared/ui/useModal";
import { Tabs } from "../../shared/ui/Tabs";
import { listAssignments } from "../projects/assignment-api";
import { allPages, createReviewClient } from "../reviews/review-client";
import type { Decision } from "../reviews/review-types";
import { ProgressReviews } from "../reviews/ProgressReviews";
import { readDashboardPublications, type StudentPublication } from "./student-publication";
import "../publications/publication.css";
import "../reviews/reviews.css";
import { createWorkspaceClient } from "./workspace-api";
import { studentProjectRows, type StudentProjectRow } from "./student-projects";
import { loadStudentFeedback } from "./student-feedback";
import { Icon } from "@iconify/react/offline";
import info from "@iconify-icons/lucide/info";
import close from "@iconify-icons/lucide/x";
import { dueLabel, projectCover, type RenderWorkspace } from "./dashboard";
import { DashboardSkeleton } from "./DashboardSkeleton";
import { CreatorProjectCard, CreatorApproval } from "./CreatorProjectCard";
import { PublishedProjects } from "./PublishedProjects";
import { RequestApproval } from "../reviews/RequestApproval";
import { PublishDialog } from "../publications/PublishDialog";
import "./student-projects.css";

const workspace = createWorkspaceClient();
const accounts = createAccountClient();
const reviews = createReviewClient();
const ignoreGuard = () => {};

export function StudentProjectDetails({
  row,
  feedback,
  feedbackLoading,
  feedbackError,
  actorId,
  onClose,
  onOpen,
  onReviewChanged,
}: {
  row: StudentProjectRow;
  feedback: readonly Decision[];
  feedbackLoading: boolean;
  feedbackError: string;
  actorId: string;
  onClose: () => void;
  onOpen: () => void;
  onReviewChanged?: () => void;
}) {
  const assignment = row.assignment?.details;
  const initialReview = assignment?.projects.find(
    (project) => project.projectId === row.project.projectId,
  )?.reviewState;
  const [submittedState, setSubmittedState] = useState<"pending" | "approved" | null>(null);
  const approved = (submittedState ?? initialReview) === "approved";
  const pending = (submittedState ?? initialReview) === "pending";
  const [action, setAction] = useState<"request" | "publish" | null>(null);
  // Open once both review sources settle so the compact popup starts at its final size
  const [historyReady, setHistoryReady] = useState(!assignment);
  const markHistoryReady = useCallback(() => setHistoryReady(true), []);
  // Keep one modal visible while preserving the details scroll and review state
  const modal = useModal(historyReady && !feedbackLoading && action === null);
  return (
    <>
      <dialog
        ref={modal}
        className="sp-dialog sp-creator-detail-dialog"
        aria-label="Project details"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <section
          className="sp-student-detail"
          aria-label="Project details"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <ProjectImageView
            className="sp-student-detail-image"
            image={row.project.image ?? null}
            fallback={projectCover(row.project.title, true)}
          />
          <div className="sp-student-detail-content">
            <div className="sp-student-detail-heading">
              <h1>{row.project.title}</h1>
              <Button
                className="sp-close-button"
                aria-label="Close project details"
                autoFocus
                onClick={onClose}
              >
                <Icon icon={close} width={38} aria-hidden="true" />
              </Button>
            </div>
            {assignment && (
              <>
                <div className="sp-student-detail-badges">
                  <span
                    title={`Assigned by: ${assignment.assignedBy ?? row.assignment?.className}`}
                  >
                    Assigned by: {assignment.assignedBy ?? row.assignment?.className}
                  </span>
                  <span className="sp-student-detail-due">
                    {dueLabel(assignment.dueAtUnixSeconds)}
                  </span>
                  <CreatorApproval row={row} submittedState={submittedState} />
                </div>
              </>
            )}
            <div className="sp-student-detail-scroll">
              {assignment && (
                <>
                  <div className="sp-student-detail-section">
                    <h2>Project Description:</h2>
                    <p>{assignment.description}</p>
                  </div>
                  <div className="sp-student-detail-section">
                    <h2>Project Instructions:</h2>
                    <p>{assignment.instructions}</p>
                  </div>
                </>
              )}
              {!assignment && <p>Assignment details are not available for this project.</p>}
              <div className="sp-student-detail-comments">
                <h2>Reviews:</h2>
                {assignment && (
                  <ProgressReviews
                    key={`${row.project.projectId}:${actorId}`}
                    projectId={row.project.projectId}
                    revision={row.project.revision}
                    actorId={actorId}
                    educator={false}
                    decisions={feedback}
                    decisionsLoading={feedbackLoading}
                    decisionsError={feedbackError}
                    onHistorySettled={markHistoryReady}
                    onGuard={ignoreGuard}
                  />
                )}
              </div>
            </div>
            <div className="sp-student-detail-actions">
              {assignment && !pending && (
                <Button
                  disabled={row.project.archived || !row.project.permissions.canEdit}
                  onClick={() => setAction(approved ? "publish" : "request")}
                >
                  {approved ? "Publish" : pending ? "Awaiting approval" : "Request approval"}
                </Button>
              )}
              <Button
                variant="primary"
                aria-label="Open project"
                disabled={!row.project.permissions.canEdit || row.project.archived}
                onClick={onOpen}
              >
                {row.project.revision === 0 ? "Start Editing" : "Continue Editing"}
              </Button>
            </div>
          </div>
        </section>
      </dialog>
      {action === "request" && (
        <RequestApproval
          projectId={row.project.projectId}
          actorId={actorId}
          onClose={() => setAction(null)}
          onSubmitted={(_revision, approved) => {
            setSubmittedState(approved ? "approved" : "pending");
            // Refresh the card too so closing details cannot show the previous review state
            onReviewChanged?.();
            if (approved) setAction("publish");
          }}
        />
      )}
      {action === "publish" && (
        <PublishDialog
          projectId={row.project.projectId}
          actorId={actorId}
          onClose={() => setAction(null)}
        />
      )}
    </>
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
  const [tab, setTab] = useState<"projects" | "published">(() =>
    new URLSearchParams(location.search).get("tab") === "published" ? "published" : "projects",
  );
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(
    () => ({ session, tab, listVersion, attempt }),
    [session, tab, listVersion, attempt],
  );
  const [list, setList] = useState<{
    request: typeof request;
    rows: StudentProjectRow[] | "error";
    links: Map<string, StudentPublication> | null;
  } | null>(null);
  // Keep the current tab intact until its replacement is ready; never reuse another account's view
  const switchingTab =
    list?.request.session === session &&
    list.request.listVersion === listVersion &&
    list.request.attempt === attempt &&
    list.request.tab !== tab;
  const result = list?.request === request || switchingTab ? list : null;
  const shownTab = result?.request.tab ?? tab;
  const rows = result?.rows;
  // Keep the list mounted so closing details restores its trigger and browsing position
  const [selected, setSelected] = useState<StudentProjectRow | null>(null);
  const [feedback, setFeedback] = useState<Decision[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  useEffect(() => {
    if (!active) return;
    const { session, tab } = request;
    let disposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        // Read links first so a new grant is reflected in the project rows used to display it.
        const links =
          tab === "published"
            ? await readDashboardPublications(session.userId, controller.signal)
            : null;
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
        if (!disposed)
          setList({
            request,
            links,
            rows: studentProjectRows(session.userId, projects, assignments),
          });
      } catch {
        if (!disposed) setList({ request, rows: "error", links: null });
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [active, request]);
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
  const published = shownTab === "published";
  return renderWorkspace(
    <section className="sp-student-dashboard" aria-labelledby="creator-heading" data-tab={shownTab}>
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
        value={shownTab}
        items={[
          { value: "projects", label: "Projects" },
          { value: "published", label: "Published" },
        ]}
        onChange={(next) => {
          setSelected(null);
          setTab(next);
        }}
      />
      <div
        id="student-projects-panel"
        role="tabpanel"
        aria-labelledby={`student-projects-${shownTab}`}
        aria-busy={switchingTab}
      >
        {rows === "error" ? (
          <div role="alert" className="sp-dashboard-state">
            <p>
              {published ? "Published projects" : "Your projects"} could not be loaded. Try again.
            </p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : !rows ? (
          <DashboardSkeleton view={published ? "published" : "creator"} />
        ) : result?.links ? (
          <PublishedProjects rows={rows} links={result.links} name={session.displayName} />
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
      {selected && (
        <StudentProjectDetails
          key={`${selected.project.projectId}:${session.userId}`}
          row={selected}
          feedback={feedback}
          feedbackLoading={feedbackLoading}
          feedbackError={feedbackError}
          actorId={session.userId}
          onClose={() => setSelected(null)}
          onReviewChanged={() => setAttempt((n) => n + 1)}
          onOpen={() => onOpenProject(selected.project.projectId)}
        />
      )}
    </section>,
    published ? "creator-published" : "creator-projects",
  );
}
