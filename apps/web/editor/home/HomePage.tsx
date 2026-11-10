import { useEffect, useRef, useState } from "react";
import { WorkspaceAccountGate, type WorkspaceAccess } from "../accounts/WorkspaceAccountGate";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { Icon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import type { RenderWorkspace } from "./dashboard";
import washLeft from "../../shared/ui/assets/facilitator-ambient-top.svg";
import facilitatorWashRight from "../../shared/ui/assets/facilitator-ambient-bottom.svg";
import washRight from "./assets/ambient-bottom.svg";
import creatorDetailBackground from "./assets/creator-detail-background.webp";
import { useWorkspaceDeparture } from "../workspace/useWorkspaceDeparture";
import { ProjectHome } from "./ProjectHome";
import { StudentProjects } from "./StudentProjects";
import { TeacherProjects } from "./TeacherProjects";
import { ClassHome } from "./ClassHome";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { AssignmentCreationScreen } from "../projects/AssignmentScreens";
import type { FormNavigationState } from "../projects/NewProjectForm";
import "./home.css";
import "./dashboard.css";

export function HomePage() {
  return <WorkspaceAccountGate>{(access) => <HomeWorkspace {...access} />}</WorkspaceAccountGate>;
}

function HomeWorkspace({ session, active, onSignOut }: WorkspaceAccess) {
  const [view, setView] = useState<"projects" | "classes" | "assignment" | "denied">(() => {
    const path = location.pathname.replace(/\/$/, "");
    if (path === "/classes") return "classes";
    if (path === "/new-project")
      return session.role === "Administrator" || session.role === "Educator"
        ? "assignment"
        : "denied";
    return "projects";
  });
  const organisationView =
    session.role === "Educator" &&
    view === "classes" &&
    new URLSearchParams(location.search).get("organisation") === "1";
  const [navigation, setNavigation] = useState<FormNavigationState>({
    dirty: false,
    locked: false,
  });
  const [newProject, setNewProject] = useState(
    location.pathname.replace(/\/$/, "") === "/new-project",
  );
  const { navigate, confirmation } = useWorkspaceDeparture(active, {
    dirty: navigation.dirty,
    pending: navigation.locked,
  });
  const [assignmentClassId, setAssignmentClassId] = useState(
    () => new URLSearchParams(location.search).get("classId") ?? "",
  );
  const previousView = useRef(view);
  useEffect(() => {
    if (!navigation.dirty && !navigation.locked) return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [navigation.dirty, navigation.locked]);
  function openProject(projectId: string) {
    navigate(() => location.assign(`/?projectId=${encodeURIComponent(projectId)}`));
  }
  useEffect(() => {
    if (view !== "projects" || session.role === "Administrator" || previousView.current !== view) {
      document.getElementById("workspace")?.focus();
    }
    previousView.current = view;
  }, [view, session.role]);
  const navigationBar = (
    <WorkspaceNavigation
      role={session.role}
      current={view}
      locked={navigation.locked}
      onNavigate={navigate}
      onProjects={() => setView("projects")}
      onClasses={() => setView("classes")}
    />
  );
  const renderWorkspace: RenderWorkspace = (content, dashboard) => (
    <WorkspaceShell
      header={{
        account: session,
        homeHref: "/home",
        onHome: () => navigate(() => location.assign("/home")),
        onSignOut: () => navigate(onSignOut),
        locked: navigation.locked,
      }}
      variant={
        dashboard?.startsWith("facilitator") ||
        organisationView ||
        (session.role === "Educator" && newProject)
          ? "facilitator"
          : dashboard
            ? "creator"
            : undefined
      }
      appearance={
        dashboard === "creator-projects" || dashboard === "creator-published"
          ? { washLeft, washRight: facilitatorWashRight }
          : dashboard || organisationView || (session.role === "Educator" && newProject)
            ? {
                washLeft: session.role === "Educator" ? washLeft : creatorDetailBackground,
                washRight: session.role === "Educator" ? facilitatorWashRight : washRight,
              }
            : undefined
      }
    >
      {session.role === "Administrator" && (
        <div className="sp-admin-return">
          <button
            type="button"
            className="sp-button sp-close-button"
            aria-label="Back to dashboard"
            disabled={navigation.locked}
            onClick={() => navigate(() => location.assign("/admin/dashboard"))}
          >
            <Icon icon={closeIcon} aria-hidden="true" />
          </button>
        </div>
      )}
      {!dashboard &&
        !organisationView &&
        !(session.role === "Educator" && view === "assignment" && newProject) &&
        navigationBar}
      {content}
      {confirmation}
    </WorkspaceShell>
  );
  if (view === "projects" && session.role === "Educator")
    return <TeacherProjects session={session} listVersion={0} renderWorkspace={renderWorkspace} />;
  if (view === "projects" && session.role === "Creator")
    return (
      <StudentProjects
        session={session}
        active={active}
        listVersion={0}
        renderWorkspace={renderWorkspace}
        onOpenProject={openProject}
      />
    );
  return renderWorkspace(
    view === "projects" ? (
      <ProjectHome
        session={session}
        active={active}
        onOpenProject={openProject}
        onNavigationStateChange={setNavigation}
      />
    ) : view === "classes" ? (
      <ClassHome
        session={session}
        active={active}
        onCreateAssignment={(classId) => {
          setAssignmentClassId(classId);
          setNewProject(false);
          setView("assignment");
        }}
        onOpenProject={openProject}
        onClose={() =>
          navigate(() => {
            const params = new URLSearchParams(location.search);
            const classId = params.get("classId");
            const assignmentId = params.get("assignmentId");
            location.assign(
              classId && assignmentId
                ? `/home?${new URLSearchParams({ classId, assignmentId })}`
                : "/home",
            );
          })
        }
      />
    ) : view === "denied" ? (
      <h1>Access denied</h1>
    ) : (
      <div className={newProject ? "sp-teacher-new-project" : undefined}>
        <div className="sp-page-heading sp-teacher-detail-head">
          <div>
            <h1>{newProject ? "New Project" : "New class assignment"}</h1>
            <p>
              {newProject || session.role === "Educator"
                ? "Set up a new experience, add your project details and choose your students."
                : "Create an independent project for each selected student from an existing source project."}
            </p>
          </div>
          {newProject && (
            <Button
              className="sp-close-button"
              aria-label="Close new project"
              onClick={() => navigate(() => location.assign("/home"))}
            >
              <Icon icon={closeIcon} aria-hidden="true" />
            </Button>
          )}
        </div>
        <AssignmentCreationScreen
          {...(newProject
            ? {
                onCreated: () => {
                  history.replaceState(null, "", "/home");
                  setNewProject(false);
                  setView("projects");
                },
              }
            : {})}
          expectedUserId={session.userId}
          createBlank={session.role === "Educator"}
          initialClassId={assignmentClassId}
          onCancel={() =>
            navigate(() => (newProject ? location.assign("/home") : setView("classes")))
          }
          onNavigationStateChange={setNavigation}
          onOpenProject={openProject}
        />
      </div>
    ),
  );
}
