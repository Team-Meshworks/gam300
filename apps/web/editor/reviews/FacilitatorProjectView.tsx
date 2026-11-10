import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import { createClassroomClient } from "../home/classroom-api";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import {
  readServerAssets,
  readServerProject,
  type OpenedServerProject,
} from "../persistence/server-project-read";
import { readAssignment } from "../projects/assignment-api";
import {
  parseProgressContext,
  reviewReturnUrl,
  type ProgressContext,
} from "../projects/progress-navigation";
import { createDocumentStore } from "../document-store";
import { App, type ServerEditorSession } from "../App";
import { allPages, createReviewClient } from "./review-client";
import { Button } from "../../shared/ui/Button";
import { ProgressReviews } from "./ProgressReviews";
import "./reviews.css";
import "./facilitator-project.css";

const accounts = createAccountClient();
const reviews = createReviewClient();

export function FacilitatorProjectView({
  session,
  context,
}: {
  session: AccountSession;
  context: ProgressContext;
}) {
  const [loaded, setLoaded] = useState<{
    opened: OpenedServerProject;
    assets: readonly CatalogueAsset[];
    name: string;
    title: string;
    className: string;
    submissionStatus: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const className = createClassroomClient()
        .classes(controller.signal)
        .then((classes) => classes.find((row) => row.id === context.classId)?.name ?? "")
        .catch(() => "");
      const assignment = await readAssignment(
        context.classId,
        context.assignmentId,
        controller.signal,
      );
      const student = assignment.projects.find(
        (row) => row.projectId === context.projectId && row.studentId === context.studentId,
      );
      if (!student) throw new Error("This student project is unavailable in the selected class.");
      const assets = await readServerAssets(
        session.userId,
        controller.signal,
        fetch,
        context.projectId,
      );
      const opened = await readServerProject(
        context.projectId,
        session.userId,
        new Map(assets.map((asset) => [asset.id, asset.kind])),
        controller.signal,
      );
      if (!opened.ok) throw new Error(opened.error.message);
      const submissions = await allPages((cursor) =>
        reviews.submissions(context.projectId, cursor),
      );
      const latest = submissions.sort((a, b) => b.sequence - a.sequence)[0];
      const submitted = latest
        ? await reviews.getReview(context.projectId, latest.submissionId)
        : null;
      const inspectSubmission =
        submitted && (!submitted.latestDecision || submitted.latestDecision.outcome === "approved");
      const inspected = inspectSubmission
        ? {
            ...opened.value,
            document: submitted.document,
            revision: submitted.revision,
            canEdit: false,
          }
        : opened.value;
      if (
        inspectSubmission &&
        submitted.assetReferences.some(
          (reference) =>
            !assets.some(
              (asset) => asset.id === reference.assetId && asset.sha256 === reference.sha256,
            ),
        )
      )
        throw new Error(
          "The submitted exhibition's original assets are unavailable. Its content has not been substituted.",
        );
      const identity = await accounts.getSession();
      if (
        identity?.userId !== session.userId ||
        identity.role !== "Educator" ||
        identity.mustChangePassword
      )
        throw new Error("Your account changed. Sign in again to review this project.");
      const loadedClassName = await className;
      if (!controller.signal.aborted)
        setLoaded({
          opened: inspected,
          assets,
          name: student.studentName ?? "Student",
          title: assignment.title,
          className: loadedClassName,
          submissionStatus:
            student.approvalStatus === "not-submitted" || student.reviewState === "draft"
              ? "In Progress"
              : student.approvalStatus === "awaiting-approval" || student.reviewState === "pending"
                ? "Completed and submitted"
                : student.approvalStatus === "approved" || student.reviewState === "approved"
                  ? "Approved"
                  : student.approvalStatus === "returned" || student.reviewState === "returned"
                    ? "Changes requested"
                    : student.approvalStatus === "revoked" || student.reviewState === "revoked"
                      ? "Approval revoked"
                      : "Status unavailable",
        });
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "The student project could not be opened.",
        );
    });
    return () => controller.abort();
  }, [session.userId, context, attempt]);
  const store = useMemo(() => {
    const next = createDocumentStore(loaded?.assets ?? []);
    if (loaded)
      next.loadProject(
        JSON.stringify(loaded.opened.document),
        new Map(loaded.assets.map((asset) => [asset.id, asset.kind])),
      );
    return next;
  }, [loaded]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const preview = useMemo<ServerEditorSession | null>(
    () =>
      loaded
        ? {
            assets: loaded.assets,
            selectionAssets: loaded.assets,
            store,
            title: loaded.opened.document.title,
            dirty: false,
            failed: false,
            saving: false,
            departing: false,
            busy: false,
            save: async () => false,
            leave: () => {},
            openServerVersion: () => {},
            logout: () => {},
            importFile: async () => {},
          }
        : null,
    [loaded, store],
  );
  return (
    <main className="facilitator-project-view">
      <header className="facilitator-project-header">
        <a
          className="sp-button sp-close-button facilitator-project-close"
          aria-label="Close student project"
          title="Close student project"
          href={reviewReturnUrl(new URLSearchParams(location.search), "Educator")}
        >
          <Icon icon={closeIcon} width={18} aria-hidden="true" />
        </a>
        <h1>{loaded?.opened.document.title ?? "Student project"}</h1>
        <Button
          className="facilitator-project-review"
          title="Write feedback or approve this submission"
          disabled={!loaded}
          onClick={() => setReview(true)}
        >
          Review
        </Button>
      </header>
      <div className="facilitator-project-canvas">
        {preview && <App server={preview} readOnlyPreview />}
      </div>
      {error ? (
        <div className="facilitator-project-status" role="alert">
          <p>{error}</p>
          <Button
            onClick={() => {
              setLoaded(null);
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : !loaded ? (
        <p role="status" className="facilitator-project-status">
          Opening student project…
        </p>
      ) : null}
      {loaded && loaded.opened.document.scenes.length > 1 && (
        <nav className="facilitator-project-scenes" aria-label="Scenes">
          {loaded.opened.document.scenes.map((scene) => (
            <Button
              key={scene.id}
              aria-pressed={snapshot.activeSceneId === scene.id}
              onClick={() => store.switchScene(scene.id)}
            >
              {scene.name}
            </Button>
          ))}
        </nav>
      )}
      {review && loaded && (
        <ProgressReviews
          projectId={context.projectId}
          revision={loaded.opened.revision}
          actorId={session.userId}
          orgId={session.orgId}
          educator
          autoOpen
          publication={{
            studentId: context.studentId,
            studentName: loaded.name,
            projectTitle: loaded.title,
            className: loaded.className,
            submissionStatus: loaded.submissionStatus,
          }}
          onGuard={() => {}}
          onClose={() => setReview(false)}
        />
      )}
    </main>
  );
}

export function ProjectEntry({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const [session, setSession] = useState<AccountSession | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [context] = useState(() =>
    parseProgressContext(new URLSearchParams(location.search), projectId),
  );
  useEffect(() => {
    let cancelled = false;
    void accounts
      .getSession()
      .then((identity) => {
        if (!cancelled) setSession(identity);
      })
      .catch(() => {
        if (!cancelled) setError("Your account could not be checked. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (session?.role === "Educator" && !context && !session.mustChangePassword)
      location.replace(`/review?projectId=${encodeURIComponent(projectId)}`);
  }, [session, context, projectId]);
  if (error)
    return (
      <main>
        <p role="alert">{error}</p>
        <a href="/home">Home</a>
      </main>
    );
  if (session === undefined)
    return (
      <main className="editor-opening">
        <p role="status">Checking your account…</p>
      </main>
    );
  if (session?.role === "Educator" && !session.mustChangePassword)
    return context ? (
      <FacilitatorProjectView session={session} context={context} />
    ) : (
      <main>
        <p role="status">Opening student review…</p>
      </main>
    );
  return children;
}
