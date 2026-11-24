import { requestedProjectId } from "../projects/progress-navigation";
import { PublishedProjectsLoading } from "../admin/PublishedProjectsLoading";
import { LoadingSummary } from "../../shared/ui/LoadingSkeleton";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";

export function WorkspaceLoading() {
  const adminDashboard = location.pathname.replace(/\/$/, "") === "/admin/dashboard";
  if (adminDashboard) {
    const detail = Boolean(requestedProjectId());
    if (detail || new URLSearchParams(location.search).get("view") === "projects") {
      return (
        <WorkspaceShell
          variant="dashboard"
          header={{ account: null, homeHref: "/admin/dashboard", locked: true }}
        >
          <div className="admin-dashboard">
            <PublishedProjectsLoading detail={detail} />
          </div>
        </WorkspaceShell>
      );
    }
  }
  return (
    <WorkspaceShell header={{ account: null, homeHref: "/home", locked: true }}>
      <div className={`sp-workspace-loading${adminDashboard ? " admin-home-session-loading" : ""}`}>
        <LoadingSummary label="Checking your session…" />
      </div>
    </WorkspaceShell>
  );
}
