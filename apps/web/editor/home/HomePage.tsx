import { useEffect, useRef, useState } from "react";
import { WorkspaceAccountGate, type WorkspaceAccess } from "../accounts/WorkspaceAccountGate";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { Icon } from "@iconify/react/offline";
import chevronDown from "@iconify-icons/lucide/chevron-down";
import { DashboardSettings } from "./DashboardSettings";
import type { RenderWorkspace } from "./dashboard";
import washLeft from "./assets/ambient-top.svg";
import washRight from "./assets/ambient-bottom.svg";
import creatorWashRight from "./assets/ambient-creator.svg";
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
  const [manage, setManage] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const [assignmentClassId, setAssignmentClassId] = useState("");
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
        actions: dashboard === "creator-projects" && <DashboardSettings />,
      }}
      variant={dashboard ? (dashboard === "facilitator" ? "facilitator" : "creator") : undefined}
      appearance={
        dashboard
          ? {
              washLeft,
              washRight: dashboard === "creator-projects" ? creatorWashRight : washRight,
            }
          : undefined
      }
      footer={
        dashboard && (
          <footer className="sp-dashboard-tools">
            {navigationBar}
            <details
              open={manage}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                if (manage && !open) setListVersion((value) => value + 1);
                setManage(open);
              }}
            >
              <summary>
                Manage projects and archives <Icon icon={chevronDown} width={16} />
              </summary>
              {manage && (
                <ProjectHome
                  session={session}
                  active={active}
                  onOpenProject={openProject}
                  onNavigationStateChange={setNavigation}
                  showCreation={session.role === "Creator"}
                />
              )}
            </details>
          </footer>
        )
      }
    >
      {session.role === "Administrator" && (
        <div className="sp-admin-return">
          <button
            type="button"
            aria-label="Back to dashboard"
            disabled={navigation.locked}
            onClick={() => navigate(() => location.assign("/admin/dashboard"))}
          >
            ×
          </button>
        </div>
      )}
      {!dashboard &&
        !(session.role === "Educator" && view === "assignment" && newProject) &&
        navigationBar}
      {content}
      {confirmation}
    </WorkspaceShell>
  );
  if (view === "projects" && session.role === "Educator")
    return (
      <TeacherProjects
        session={session}
        listVersion={listVersion}
        renderWorkspace={renderWorkspace}
      />
    );
  if (view === "projects" && session.role === "Creator")
    return (
      <StudentProjects
        session={session}
        active={active}
        listVersion={listVersion}
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
              aria-label="Close new project"
              onClick={() => navigate(() => location.assign("/home"))}
            >
              ×
            </Button>
          )}
        </div>
        <AssignmentCreationScreen
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
