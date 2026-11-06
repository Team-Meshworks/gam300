import { useEffect, useMemo, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { LoginRedirect } from "../accounts/LoginRedirect";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { HomePage } from "../home/HomePage";
import { WorkspaceNavigation } from "../home/WorkspaceNavigation";
import { AccountDirectoryPage } from "../directory/AccountDirectoryPage";
import { AdminDashboard } from "../admin/AdminDashboard";
import { ReviewWorkspace } from "../reviews/ReviewWorkspace";
import { PublicationPage } from "../publications/PublicationPage";
import { AssetAdministration } from "../asset-administration/AssetAdministration";
import { createAssetAdministrationService } from "../asset-administration/asset-administration-service";

const client = createAccountClient();
const screens = [
  { id: "publish", title: "Publish project", roles: ["Administrator", "Educator", "Creator"] },
  { id: "assets", title: "3D Assets", roles: ["Administrator"] },
  { id: "spaces", title: "3D Spaces", roles: ["Administrator"] },
  { id: "admin/dashboard", title: "Dashboard", roles: ["Administrator"] },
  { id: "classes", title: "Classes", roles: ["Administrator", "Educator"] },
  { id: "review", title: "Submission review", roles: ["Creator", "Educator"] },
  { id: "organisations", title: "Organisations", roles: ["Administrator"] },
];
type Access =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; session: AccountSession | null };

// Route visibility follows the session; each screen's API enforces access to its records.
export function WorkspacePage() {
  const path = location.pathname.replace(/\/$/, "");
  if (path === "/classes" || path === "/new-project") return <HomePage />;
  return <OtherWorkspacePage />;
}

function OtherWorkspacePage() {
  const [access, setAccess] = useState<Access>({ kind: "loading" });
  const assetService = useMemo(
    () =>
      access.kind === "ready" && access.session
        ? createAssetAdministrationService(access.session.userId)
        : null,
    [access],
  );
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
  if (!session)
    return (
      <main className="sp-workspace">
        <LoginRedirect />
      </main>
    );
  if (session.mustChangePassword)
    return (
      <main className="sp-workspace">
        <h1>Password change required</h1>
        <p>Change your password before opening your workspace.</p>
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
  const organisations = screen?.id === "organisations" && permitted.includes(screen);
  const review = screen?.id === "review" && permitted.includes(screen);
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
      homeHref={review ? "/home" : fallback}
      variant={dashboard ? "dashboard" : undefined}
      onSignOut={() => void signOut()}
    >
      {review ? (
        <WorkspaceNavigation role={session.role} current="reviews" />
      ) : !dashboard && !organisations ? (
        <nav className="sp-workspace-links" aria-label="Workspace screens">
          <a href="/home">Projects</a>
          {permitted
            .filter((item) => item.id !== "publish")
            .map((item) => (
              <a
                key={item.id}
                aria-current={screen === item ? "page" : undefined}
                href={`/${item.id}`}
              >
                {item.title}
              </a>
            ))}
        </nav>
      ) : null}
      {logoutError && <p role="alert">{logoutError}</p>}
      {!screen || !permitted.includes(screen) ? (
        <h1>Access denied</h1>
      ) : (
        <>
          {!dashboard &&
            !review &&
            !organisations &&
            screen.id !== "assets" &&
            screen.id !== "spaces" && <h1 className="sp-page-heading">{screen.title}</h1>}
          {assetService && (screen.id === "assets" || screen.id === "spaces") && (
            <AssetAdministration
              key={session.userId}
              session={session}
              service={assetService}
              kind={screen.id === "spaces" ? "environment" : "model"}
              onClose={() => location.assign(fallback)}
            />
          )}
          {dashboard && <AdminDashboard key={session.userId} session={session} />}
          {screen.id === "review" && (
            <ReviewWorkspace key={session.userId + ":" + session.orgId} session={session} />
          )}
          {screen.id === "organisations" && (
            <AccountDirectoryPage key={session.userId} accountId={session.userId} />
          )}
          {screen.id === "publish" && <PublicationPage key={session.userId} session={session} />}
        </>
      )}
    </WorkspaceShell>
  );
}
