import { useEffect, useMemo, useState } from "react";
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
  { id: "publish", title: "Publish project", roles: ["Administrator", "Educator", "Creator"] },
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
  const [route, setRoute] = useState(() => ({ href: location.pathname + location.search, key: 0 }));
  const path = new URL(route.href, location.origin).pathname.replace(/\/$/, "");
  function openScreen(href: string) {
    history.pushState(null, "", href);
    setRoute((previous) => ({ href, key: previous.key + 1 }));
    window.scrollTo(0, 0);
  }
  useEffect(() => {
    const restored = () =>
      setRoute((previous) => ({
        href: location.pathname + location.search,
        key: previous.key + 1,
      }));
    window.addEventListener("popstate", restored);
    return () => window.removeEventListener("popstate", restored);
  }, []);
  const [guard, setGuard] = useState({ dirty: false, pending: false });
  const { navigate, confirmation } = useWorkspaceDeparture(active, guard);
  const assetService = useMemo(
    () => createAssetAdministrationService(session.userId),
    [session.userId],
  );
  if (session.role === "Educator" && location.pathname.replace(/\/$/, "") === "/review")
    return <EducatorReviewLink session={session} />;
  const screen = screens.find((item) => `/${item.id}` === path);
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
      appearance={session.role === "Administrator" ? "admin" : undefined}
      onClick={(event) => {
        if (
          session.role !== "Administrator" ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (
          !(anchor instanceof HTMLAnchorElement) ||
          anchor.hasAttribute("download") ||
          (anchor.target && anchor.target !== "_self")
        )
          return;
        const destination = new URL(anchor.href);
        if (
          destination.origin !== location.origin ||
          !["/admin/dashboard", "/organisations", "/assets", "/spaces"].includes(
            destination.pathname,
          )
        )
          return;
        event.preventDefault();
        navigate(() => openScreen(destination.pathname + destination.search + destination.hash));
      }}
      header={{
        account: session,
        homeHref: review ? "/home" : fallback,
        locked: guard.pending,
        onSignOut: () => navigate(onSignOut),
      }}
      variant={
        dashboard || organisations
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
              key={`${session.userId}:${route.key}`}
              session={session}
              service={assetService}
              kind={screen.id === "spaces" ? "environment" : "model"}
              initialUpload={new URLSearchParams(location.search).get("add") === "1"}
              onClose={() => navigate(() => openScreen(fallback))}
            />
          )}
          {dashboard && (
            <AdminDashboard
              key={`${session.userId}:${route.key}`}
              session={session}
              onOpenOrganisations={() => navigate(() => openScreen("/organisations"))}
            />
          )}
          {screen.id === "review" && (
            <ReviewWorkspace session={session} guard={guard} onGuard={setGuard} />
          )}
          {screen.id === "organisations" && (
            <AccountDirectoryPage
              key={`${session.userId}:${route.key}`}
              accountId={session.userId}
            />
          )}
          {screen.id === "publish" && <PublicationPage session={session} onGuard={setGuard} />}
        </>
      )}
      {confirmation}
    </WorkspaceShell>
  );
}
