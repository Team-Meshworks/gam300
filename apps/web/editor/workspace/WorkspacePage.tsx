import { useMemo, useState } from "react";
import { WorkspaceAccountGate, type WorkspaceAccess } from "../accounts/WorkspaceAccountGate";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { HomePage } from "../home/HomePage";
import { WorkspaceNavigation } from "../home/WorkspaceNavigation";
import { AccountDirectoryPage } from "../directory/AccountDirectoryPage";
import { AdminDashboard } from "../admin/AdminDashboard";
import { EducatorReviewLink } from "../reviews/EducatorReviewLink";
import { ReviewWorkspace } from "../reviews/ReviewWorkspace";
import { PublicationPage } from "../publications/PublicationPage";
import { AssetAdministration } from "../asset-administration/AssetAdministration";
import { createAssetAdministrationService } from "../asset-administration/asset-administration-service";
import { useWorkspaceDeparture } from "./useWorkspaceDeparture";

const screens = [
  { id: "publish", title: "Publish project", roles: ["Administrator", "Educator"] },
  { id: "assets", title: "3D Assets", roles: ["Administrator"] },
  { id: "spaces", title: "3D Spaces", roles: ["Administrator"] },
  { id: "admin/dashboard", title: "Dashboard", roles: ["Administrator"] },
  { id: "classes", title: "Classes", roles: ["Administrator", "Educator"] },
  { id: "review", title: "Submission review", roles: ["Creator"] },
  { id: "organisations", title: "Organisations", roles: ["Administrator"] },
];

// Route visibility follows the session; each screen's API enforces access to its records.
export function WorkspacePage() {
  const path = location.pathname.replace(/\/$/, "");
  if (path === "/classes" || path === "/new-project") return <HomePage />;
  return (
    <WorkspaceAccountGate>{(access) => <OtherWorkspacePage {...access} />}</WorkspaceAccountGate>
  );
}

function OtherWorkspacePage({ session, active, onSignOut }: WorkspaceAccess) {
  const [guard, setGuard] = useState({ dirty: false, pending: false });
  const { navigate, confirmation } = useWorkspaceDeparture(active, guard);
  const assetService = useMemo(
    () => createAssetAdministrationService(session.userId),
    [session.userId],
  );
  if (session.role === "Educator" && location.pathname.replace(/\/$/, "") === "/review")
    return <EducatorReviewLink session={session} />;
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
  return (
    <WorkspaceShell
      header={{
        account: session,
        homeHref: review ? "/home" : fallback,
        locked: guard.pending,
        onSignOut: () => navigate(onSignOut),
      }}
      variant={
        dashboard
          ? "dashboard"
          : screen?.id === "assets" || screen?.id === "spaces"
            ? "asset-administration"
            : undefined
      }
    >
      {review ? (
        <WorkspaceNavigation role={session.role} current="reviews" />
      ) : !dashboard && !organisations && session.role !== "Administrator" ? (
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
      {!screen || !permitted.includes(screen) ? (
        <h1>Access denied</h1>
      ) : (
        <>
          {!dashboard &&
            !review &&
            !organisations &&
            screen.id !== "assets" &&
            screen.id !== "spaces" && <h1 className="sp-page-heading">{screen.title}</h1>}
          {(screen.id === "assets" || screen.id === "spaces") && (
            <AssetAdministration
              key={session.userId}
              session={session}
              service={assetService}
              kind={screen.id === "spaces" ? "environment" : "model"}
              initialUpload={new URLSearchParams(location.search).get("add") === "1"}
              onClose={() => location.assign(fallback)}
            />
          )}
          {dashboard && <AdminDashboard key={session.userId} session={session} />}
          {screen.id === "review" && (
            <ReviewWorkspace session={session} guard={guard} onGuard={setGuard} />
          )}
          {screen.id === "organisations" && (
            <AccountDirectoryPage key={session.userId} accountId={session.userId} />
          )}
          {screen.id === "publish" && <PublicationPage session={session} onGuard={setGuard} />}
        </>
      )}
      {confirmation}
    </WorkspaceShell>
  );
}
