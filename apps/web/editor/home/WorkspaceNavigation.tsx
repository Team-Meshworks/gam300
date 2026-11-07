import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import "./workspace-navigation.css";

type WorkspaceView = "projects" | "classes" | "assignment" | "reviews" | "denied";
type NavigationItem = {
  id: string;
  label: string;
  href: string;
  action?: (() => void) | undefined;
};

export function WorkspaceNavigation({
  role,
  current,
  locked = false,
  onNavigate,
  onProjects,
  onClasses,
}: {
  role: AccountSession["role"];
  current: WorkspaceView;
  locked?: boolean;
  onNavigate?: (action: () => void) => void;
  onProjects?: () => void;
  onClasses?: () => void;
}) {
  const active = current === "assignment" ? "classes" : current;
  const items: NavigationItem[] = [
    { id: "projects", label: "Projects", href: "/home", action: onProjects },
    { id: "classes", label: "Classes", href: "/classes", action: onClasses },
    ...(role === "Administrator"
      ? [
          { id: "organisations", label: "Organisations", href: "/organisations" },
          { id: "dashboard", label: "Dashboard", href: "/admin/dashboard" },
        ]
      : [{ id: "reviews", label: "Submissions and reviews", href: "/review" }]),
  ];

  return (
    <nav aria-label="Workspace" className="sp-home-navigation">
      {items.map((item) =>
        item.action ? (
          <Button
            key={item.id}
            disabled={locked}
            aria-current={active === item.id ? "page" : undefined}
            onClick={() => {
              if (onNavigate) onNavigate(item.action!);
              else item.action!();
            }}
          >
            {item.label}
          </Button>
        ) : (
          <a
            key={item.id}
            className="sp-button"
            href={item.href}
            aria-current={active === item.id ? "page" : undefined}
            aria-disabled={locked || undefined}
            onClick={(event) => {
              if (locked || onNavigate) {
                event.preventDefault();
                if (!locked) onNavigate?.(() => location.assign(item.href));
              }
            }}
          >
            {item.label}
          </a>
        ),
      )}
    </nav>
  );
}
