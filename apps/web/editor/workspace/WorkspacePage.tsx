import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { leaveWithUiSound } from "../audio/ui-sounds";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { NewProjectForm } from "../projects/NewProjectForm";
import { ClassAssignmentForm } from "../projects/ClassAssignmentForm";
import { AccountDirectoryPage } from "../directory/AccountDirectoryPage";
import { AdminDashboard } from "../admin/AdminDashboard";

const client = createAccountClient();
const screens = [
  { id: "admin/dashboard", title: "Dashboard", roles: ["Administrator"] },
  { id: "new-project", title: "New Project", roles: ["Administrator", "Educator", "Creator"] },
  { id: "classes", title: "Class assignments", roles: ["Administrator", "Educator"] },
  { id: "review", title: "Submission review", roles: ["Administrator", "Educator"] },
  { id: "accounts", title: "Accounts", roles: ["Administrator"] },
];
type Access =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; session: AccountSession | null };

// Route visibility follows the session; each screen's API enforces access to its records.
export function WorkspacePage() {
  const [access, setAccess] = useState<Access>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [logoutError, setLogoutError] = useState("");
  const signingOut = useRef(false);
  useEffect(() => {
    let disposed = false;
    void client.getSession().then(
      (session) => {
        if (!disposed) setAccess({ kind: "ready", session });
      },
      (error: unknown) => {
        if (!disposed)
          setAccess({
            kind: "error",
            message: error instanceof Error ? error.message : "The account service is unavailable.",
          });
      },
    );
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setAccess({ kind: "loading" });
        setAttempt((value) => value + 1);
      }
    };
    window.addEventListener("pageshow", restored);
    return () => {
      disposed = true;
      window.removeEventListener("pageshow", restored);
    };
  }, [attempt]);

  if (access.kind === "loading")
    return (
      <main className="sp-workspace">
        <p role="status">Checking your session…</p>
      </main>
    );
  if (access.kind === "error")
    return (
      <main className="sp-workspace">
        <p role="alert">{access.message}</p>
        <Button
          onClick={() => {
            setAccess({ kind: "loading" });
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </Button>
        <a href="/login">Log in</a>
      </main>
    );
  const session = access.session;
  if (!session || session.mustChangePassword)
    return (
      <main className="sp-workspace">
        <h1>{session ? "Password change required" : "Log in to continue"}</h1>
        <p>
          {session
            ? "Change your password before opening your workspace."
            : "Sign in to open your workspace."}
        </p>
        <a href="/login">Log in</a>
      </main>
    );
  const screen = screens.find((item) => `/${item.id}` === location.pathname.replace(/\/$/, ""));
  const permitted = screens.filter((item) => item.roles.includes(session.role));
  const fallback =
    session.role === "Administrator"
      ? "/admin/dashboard"
      : session.role === "Creator"
        ? "/landing"
        : "/classes";
  const dashboard = screen?.id === "admin/dashboard" && session.role === "Administrator";
  const from = new URLSearchParams(location.search).get("from");
  const cancelTarget = permitted.find((item) => item.id === from && item.id !== "new-project");
  async function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    setLogoutError("");
    try {
      await client.signOut(session!.userId);
      location.assign("/login");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Sign-out failed. Please try again.");
    } finally {
      signingOut.current = false;
    }
  }
  return (
    <WorkspaceShell
      name={session.displayName}
      initials={session.displayName.slice(0, 2).toUpperCase()}
      homeHref={fallback}
      variant={dashboard ? "dashboard" : undefined}
      onSignOut={() => void signOut()}
    >
      {!dashboard && (
        <nav className="sp-workspace-links" aria-label="Workspace screens">
          {permitted.map((item) => (
            <a
              key={item.id}
              aria-current={screen === item ? "page" : undefined}
              href={`/${item.id}${item.id === "new-project" && screen && screen.id !== "new-project" ? `?from=${screen.id}` : ""}`}
            >
              {item.title}
            </a>
          ))}
        </nav>
      )}
      {logoutError && <p role="alert">{logoutError}</p>}
      {!screen || !permitted.includes(screen) ? (
        <h1>Access denied</h1>
      ) : (
        <>
          {!dashboard && <h1 className="sp-page-heading">{screen.title}</h1>}
          {dashboard && <AdminDashboard key={session.userId} session={session} />}
          {screen.id === "new-project" && (
            <>
              <p role="status">
                Project creation and class lists are currently unavailable. You can enter details
                and choose a cover image, but cannot save them yet.
              </p>
              <NewProjectForm
                organizationName="Unavailable"
                creatorName={session.displayName}
                classes={[]}
                students={[]}
                onCancel={() =>
                  leaveWithUiSound("goingBack", cancelTarget ? `/${cancelTarget.id}` : fallback)
                }
              />
            </>
          )}
          {screen.id === "classes" && (
            <>
              <p role="status">
                Class and project lists are currently unavailable. Assignments cannot be changed
                yet.
              </p>
              <ClassAssignmentForm projects={[]} classes={[]} students={[]} />
            </>
          )}
          {screen.id === "review" && (
            <p role="status">
              Submissions are currently unavailable. Review and approval will be available when
              submissions can be loaded.
            </p>
          )}
          {screen.id === "accounts" && <AccountDirectoryPage key={session.userId} />}
        </>
      )}
    </WorkspaceShell>
  );
}
