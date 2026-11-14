import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectGrantEditor } from "../editor/home/ProjectGrantEditor";
import type { AccountSession } from "../editor/accounts/account-client";
import type { ProjectSummary } from "../editor/home/workspace-api";
import "../shared/ui/foundation.css";
import "../editor/home/home.css";

// Exercise the retained editor independently of the removed product entry point.
function Fixture() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void (async () => {
      const requested = new URLSearchParams(location.search).get("projectId");
      let cursor: string | null = null;
      do {
        const data = await (
          await fetch(
            `/api/v1/projects?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
        ).json();
        const match = requested
          ? data.items.find((item: ProjectSummary) => item.projectId === requested)
          : data.items[0];
        if (match) {
          setProject(match);
          return;
        }
        cursor = data.nextCursor;
      } while (cursor);
    })();
  };
  useEffect(() => {
    const check = () =>
      void fetch("/api/v1/auth/session")
        .then((r) => r.json())
        .then(setSession);
    check();
    refresh();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  const active = !!session && !session.mustChangePassword;
  return (
    <>
      {!active && (
        <>
          <h1>Change your password to continue</h1>
          <a href="/login">Go to login</a>
        </>
      )}
      {project && <h1>{project.title}</h1>}
      {active && session.role === "Administrator" && (
        <button onClick={() => setOpen(true)}>Manage access</button>
      )}
      {session && project && open && (
        <ProjectGrantEditor
          session={session}
          project={project}
          active={active}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            refresh();
          }}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
