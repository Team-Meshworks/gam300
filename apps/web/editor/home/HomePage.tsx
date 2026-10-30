import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { ProjectHome } from "./ProjectHome";
import { ClassHome } from "./ClassHome";
import { AssignmentCreationScreen } from "../projects/AssignmentScreens";
import type { FormNavigationState } from "../projects/NewProjectForm";
import "./home.css";

const accounts = createAccountClient();

export function HomePage() {
  const [session, setSession] = useState<AccountSession | null>(null);
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
      await accounts.signOut();
      setSession(null);
    } catch {
      setError("Sign-out could not be confirmed. Retry to check your session.");
    } finally {
      signingOut.current = false;
      setChecking(false);
    }
  }
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
          <h1>{session ? "Change your password to continue" : "Log in to your workspace"}</h1>
          <a href="/login">Go to login</a>
        </div>
      )}
      {session && !session.mustChangePassword && (
        <div hidden={checking || !!error} inert={checking || !!error}>
          <HomeWorkspace
            key={`${session.userId}:${session.orgId}:${session.role}`}
            session={session}
            onSignOut={() => void signOut()}
          />
        </div>
      )}
    </>
  );
}

function HomeWorkspace({ session, onSignOut }: { session: AccountSession; onSignOut: () => void }) {
  const [view, setView] = useState<"projects" | "classes" | "assignment">("projects");
  const [navigation, setNavigation] = useState<FormNavigationState>({
    dirty: false,
    locked: false,
  });
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
  useEffect(() => {
    document.getElementById("workspace")?.focus();
  }, [view]);
  return (
    <WorkspaceShell
      name={session.displayName}
      initials={session.displayName.slice(0, 2).toUpperCase()}
      onHome={() => navigate(() => setView("projects"))}
      onSignOut={() => navigate(onSignOut)}
    >
      <nav aria-label="Workspace" className="sp-home-navigation">
        <Button
          disabled={navigation.locked}
          aria-current={view === "projects" ? "page" : undefined}
          onClick={() => navigate(() => setView("projects"))}
        >
          Projects
        </Button>
        <Button
          disabled={navigation.locked}
          aria-current={view === "classes" ? "page" : undefined}
          onClick={() => navigate(() => setView("classes"))}
        >
          Classes
        </Button>
      </nav>
      {view === "projects" ? (
        <ProjectHome session={session} />
      ) : view === "classes" ? (
        <ClassHome session={session} onCreateAssignment={() => setView("assignment")} />
      ) : (
        <>
          <div className="sp-page-heading">
            <h1>New class assignment</h1>
            <p>
              Create an independent project for each selected student from an existing source
              project.
            </p>
          </div>
          <AssignmentCreationScreen
            expectedUserId={session.userId}
            onCancel={() => navigate(() => setView("classes"))}
            onNavigationStateChange={setNavigation}
          />
        </>
      )}
      {leave && (
        <Dialog title="Leave this assignment?" onClose={() => setLeave(null)}>
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
