import { useEffect, useRef, useState } from "react";
import { WorkspaceAccountGate, type WorkspaceAccess } from "../accounts/WorkspaceAccountGate";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { Icon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import type { RenderWorkspace } from "./dashboard";
import { useWorkspaceDeparture } from "../workspace/useWorkspaceDeparture";
import { ExistingProjectPicker } from "./ExistingProjectPicker";
import { HistoricalProjectRecovery } from "./HistoricalProjectRecovery";
import { historicalCreationKey } from "./existing-project";
import { ProjectHome } from "./ProjectHome";
import { PendingCreateRecovery } from "./PendingCreateRecovery";
import { StudentProjects } from "./StudentProjects";
import { TeacherProjects } from "./TeacherProjects";
import { ClassHome } from "./ClassHome";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { AssignmentCreationScreen } from "../projects/AssignmentCreationScreen";
import type { FormNavigationState } from "../projects/NewProjectForm";
import "./home.css";
import "./dashboard.css";

export function HomePage() {
  return <WorkspaceAccountGate>{(access) => <HomeWorkspace {...access} />}</WorkspaceAccountGate>;
}

function HomeWorkspace({ session, active, onSignOut }: WorkspaceAccess) {
  const [historicalVersion, setHistoricalVersion] = useState(0);
  const [findExisting, setFindExisting] = useState(false);
  const historicalPresent = (() => {
    try {
      return sessionStorage.getItem(historicalCreationKey(session.userId)) !== null;
    } catch {
      return true;
    }
  })();
  const [view, setView] = useState<"projects" | "classes" | "assignment" | "denied">(() => {
    const path = location.pathname.replace(/\/$/, "");
    if (path === "/classes") return "classes";
    if (path === "/new-project") return session.role === "Educator" ? "assignment" : "denied";
    return "projects";
  });
  const creatorLegacyPage =
    session.role === "Creator" &&
    ["/classes", "/new-project"].includes(location.pathname.replace(/\/$/, ""));
  useEffect(() => {
    if (active && creatorLegacyPage) location.replace("/home");
  }, [active, creatorLegacyPage]);
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
  const [routeVersion, setRouteVersion] = useState(0);
  const historyIndex = useRef<number>(history.state?.spWorkspaceIndex ?? 0);
  const restoringHistory = useRef<number | null>(null);
  const confirmedHistory = useRef(false);
  useEffect(() => {
    history.replaceState({ ...history.state, spWorkspaceIndex: historyIndex.current }, "");
  }, []);
  useEffect(() => {
    if (!navigation.dirty && !navigation.locked) return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [navigation.dirty, navigation.locked]);
  useEffect(() => {
    const restoreRoute = (event: PopStateEvent) => {
      if (restoringHistory.current !== null) {
        const direction = restoringHistory.current;
        restoringHistory.current = null;
        navigate(() => {
          confirmedHistory.current = true;
          history.go(direction);
        });
        return;
      }
      const targetIndex = event.state?.spWorkspaceIndex;
      const direction =
        typeof targetIndex === "number" && targetIndex > historyIndex.current ? 1 : -1;
      if ((navigation.dirty || navigation.locked) && !confirmedHistory.current) {
        restoringHistory.current = direction;
        history.go(-direction);
        return;
      }
      confirmedHistory.current = false;
      historyIndex.current =
        typeof targetIndex === "number" ? targetIndex : historyIndex.current + direction;
      const path = location.pathname.replace(/\/$/, "");
      setNewProject(path === "/new-project");
      setAssignmentClassId(new URLSearchParams(location.search).get("classId") ?? "");
      if (path === "/classes") setView("classes");
      else if (path === "/new-project")
        setView(session.role === "Educator" ? "assignment" : "denied");
      else setView("projects");
      setRouteVersion((version) => version + 1);
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [active, navigate, navigation.dirty, navigation.locked, session.role, view]);
  function pushWorkspaceRoute(href: string) {
    historyIndex.current += 1;
    history.pushState({ ...history.state, spWorkspaceIndex: historyIndex.current }, "", href);
  }
  function openWorkspaceRoute(href: string, target: "projects" | "classes") {
    navigate(() => {
      pushWorkspaceRoute(href);
      setView(target);
    });
  }
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
      {view === "projects" && session.role !== "Creator" && (
        <PendingCreateRecovery
          key={session.userId}
          actorId={session.userId}
          purpose="import"
          active={active}
          onRecovered={(value) => openProject(value.id)}
        />
      )}
      {view === "projects" && session.role !== "Creator" && (
        <>
          <HistoricalProjectRecovery
            key={session.userId + ":" + historicalVersion}
            actorId={session.userId}
            active={active && !navigation.locked}
            onOpen={openProject}
            onSeparate={() => setHistoricalVersion((value) => value + 1)}
          />
          {!historicalPresent &&
            dashboard !== "facilitator" &&
            dashboard !== "facilitator-details" && (
              <details
                className="sp-existing-projects"
                onToggle={(event) => setFindExisting(event.currentTarget.open)}
              >
                <summary>Find an existing project</summary>
                {findExisting && (
                  <ExistingProjectPicker
                    actorId={session.userId}
                    active={active && !navigation.locked}
                    onSelect={(project) => openProject(project.projectId)}
                  />
                )}
              </details>
            )}
        </>
      )}
      {content}
      {confirmation}
    </WorkspaceShell>
  );
  if (creatorLegacyPage) return null;
  if (view === "projects" && session.role === "Educator")
    return (
      <TeacherProjects
        key={routeVersion}
        session={session}
        listVersion={0}
        renderWorkspace={renderWorkspace}
        onOpenOrganisation={(href) => openWorkspaceRoute(href, "classes")}
      />
    );
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
        key={routeVersion}
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
            pushWorkspaceRoute(
              classId && assignmentId
                ? `/home?${new URLSearchParams({ classId, assignmentId })}`
                : "/home",
            );
            setView("projects");
          })
        }
      />
    ) : view === "denied" ? (
      <h1>Access denied</h1>
    ) : (
      <div
        className={newProject ? "sp-panel-surface sp-teacher-new-project" : "sp-assignment-page"}
      >
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
                  history.replaceState(history.state, "", "/home");
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
