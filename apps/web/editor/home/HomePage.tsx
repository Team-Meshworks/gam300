import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { LoginRedirect } from "../accounts/LoginRedirect";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { ProjectHome } from "./ProjectHome";
import { TeacherProjects } from "./TeacherProjects";
import { ClassHome } from "./ClassHome";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { AssignmentCreationScreen } from "../projects/AssignmentScreens";
import type { FormNavigationState } from "../projects/NewProjectForm";
import "./home.css";

const accounts = createAccountClient();

export function HomePage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [workspaceSession, setWorkspaceSession] = useState<AccountSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const signingOut = useRef(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      if (document.visibilityState === "hidden" || signingOut.current) return;
      const current = ++generation.current;
      setChecking(true);
      try {
        const value = await accounts.getSession();
        if (!alive || current !== generation.current) return;
        setSession(value);
        if (value && !value.mustChangePassword) setWorkspaceSession(value);
        setError("");
      } catch {
        if (alive && current === generation.current)
          setError("Your session could not be verified. Retry before continuing.");
      } finally {
        if (alive && current === generation.current) setChecking(false);
      }
    }
    void check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [version]);
  async function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    generation.current++;
    setChecking(true);
    try {
      await accounts.signOut(workspaceSession?.userId);
      setSession(null);
      setWorkspaceSession(null);
    } catch {
      setError("Sign-out could not be confirmed. Retry to check your session.");
    } finally {
      signingOut.current = false;
      setChecking(false);
    }
  }
  const workspaceActive =
    !checking &&
    !error &&
    !!session &&
    !session.mustChangePassword &&
    session.userId === workspaceSession?.userId &&
    session.orgId === workspaceSession.orgId &&
    session.role === workspaceSession.role;
  return (
    <>
      <a className="sp-skip-link" href="#workspace">
        Skip to workspace
      </a>
      {checking && (
        <p className="sp-home-gate" role="status">
          Checking your session…
        </p>
      )}
      {error && (
        <div className="sp-home-gate" role="alert">
          <p>{error}</p>
          <Button onClick={() => setVersion((value) => value + 1)}>Retry</Button>
          <a href="/login">Go to login</a>
        </div>
      )}
      {!checking && !error && (!session || session.mustChangePassword) && (
        <div className="sp-home-gate">
          {session ? (
            <>
              <h1>Change your password to continue</h1>
              <a href="/login">Go to login</a>
            </>
          ) : (
            <LoginRedirect />
          )}
        </div>
      )}
      {workspaceSession && (
        <div hidden={!workspaceActive} inert={!workspaceActive}>
          <HomeWorkspace
            key={`${workspaceSession.userId}:${workspaceSession.orgId}:${workspaceSession.role}`}
            session={workspaceSession}
            active={workspaceActive}
            onSignOut={() => void signOut()}
          />
        </div>
      )}
    </>
  );
}

function HomeWorkspace({
  session,
  active,
  onSignOut,
}: {
  session: AccountSession;
  active: boolean;
  onSignOut: () => void;
}) {
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
  const [leave, setLeave] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!navigation.dirty && !navigation.locked) return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [navigation.dirty, navigation.locked]);
  function navigate(action: () => void) {
    if (navigation.locked) return;
    if (navigation.dirty) setLeave(() => action);
    else action();
  }
  function openProject(projectId: string) {
    navigate(() => location.assign(`/?projectId=${encodeURIComponent(projectId)}`));
  }
  useEffect(() => {
    document.getElementById("workspace")?.focus();
  }, [view]);
  return (
    <WorkspaceShell
      name={session.displayName}
      initials={session.displayName.slice(0, 2).toUpperCase()}
      onHome={() => navigate(() => location.assign("/home"))}
      onSignOut={() => navigate(onSignOut)}
    >
      {!(session.role === "Educator" && view === "assignment" && newProject) && (
        <WorkspaceNavigation
          role={session.role}
          current={view}
          locked={navigation.locked}
          onNavigate={navigate}
          onProjects={() => setView("projects")}
          onClasses={() => setView("classes")}
        />
      )}
      {view === "projects" ? (
        session.role === "Educator" ? (
          <TeacherProjects session={session} active={active} />
        ) : (
          <ProjectHome
            session={session}
            active={active}
            onOpenProject={openProject}
            onNavigationStateChange={setNavigation}
          />
        )
      ) : view === "classes" ? (
        <ClassHome
          session={session}
          active={active}
          onCreateAssignment={() => {
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
                {newProject
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
            createBlank={newProject && session.role === "Educator"}
            onCancel={() =>
              navigate(() => (newProject ? location.assign("/home") : setView("classes")))
            }
            onNavigationStateChange={setNavigation}
            onOpenProject={openProject}
          />
        </div>
      )}
      {leave && active && (
        <Dialog title="Leave this page?" onClose={() => setLeave(null)}>
          <p>
            Your unsent details will be discarded. Stay here to finish or keep a copy before
            leaving.
          </p>
          <Button
            onClick={() => {
              const action = leave;
              setLeave(null);
              setNavigation({ dirty: false, locked: false });
              action();
            }}
          >
            Discard details and leave
          </Button>
          <Button variant="primary" onClick={() => setLeave(null)}>
            Keep editing
          </Button>
        </Dialog>
      )}
    </WorkspaceShell>
  );
}
