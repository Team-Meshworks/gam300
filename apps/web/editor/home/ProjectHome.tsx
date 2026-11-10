import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import searchIcon from "@iconify-icons/ant-design/search-outlined";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { Dialog } from "../../shared/ui/Dialog";
import { PageState } from "../../shared/ui/PageState";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { createWorkspaceClient, projectReceipt, type ProjectSummary } from "./workspace-api";
import { ProjectGrantEditor } from "./ProjectGrantEditor";
import { ProjectCreation } from "./ProjectCreation";
import type { FormNavigationState } from "../projects/NewProjectForm";
import defaultProjectImage from "./assets/default-project-neutral.jpg";
import { projectCover } from "./dashboard";

const api = createWorkspaceClient();
const accounts = createAccountClient();

export function ProjectHome({
  session,
  active,
  onOpenProject,
  onNavigationStateChange,
  showCreation = true,
}: {
  session: AccountSession;
  active: boolean;
  onOpenProject: (projectId: string) => void;
  onNavigationStateChange?: (state: FormNavigationState) => void;
  showCreation?: boolean;
}) {
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{
    tab: string;
    version: number;
    items: ProjectSummary[] | null;
  } | null>(null);
  const [action, setAction] = useState<{
    project: ProjectSummary;
    kind: "duplicate" | "archive";
  } | null>(null);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<"ready" | "pending" | "unknown">("ready");
  const [message, setMessage] = useState("");
  const [grantProject, setGrantProject] = useState<ProjectSummary | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [phase]);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .projects(tab === "archived", controller.signal)
      .then(async (items) => {
        if ((await accounts.getSession())?.userId !== session.userId)
          throw new Error("Account changed");
        if (!controller.signal.aborted) setResult({ tab, version, items });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ tab, version, items: null });
      });
    return () => controller.abort();
  }, [tab, version, session.userId]);

  async function mutate() {
    if (!action || inFlight.current || phase !== "ready") return;
    inFlight.current = true;
    setPhase("pending");
    setMessage("");
    const { project, kind } = action;
    const outcome = await api.write(
      session.userId,
      `/api/v1/projects/${encodeURIComponent(project.projectId)}/${kind === "duplicate" ? "duplicate" : "archive"}`,
      kind === "duplicate" ? "POST" : "PATCH",
      kind === "duplicate"
        ? { expectedRevision: project.revision, title: title.trim() }
        : { expectedRevision: project.revision, archived: !project.archived },
    );
    inFlight.current = false;
    if (
      outcome.kind === "confirmed" &&
      projectReceipt(outcome.value, project, kind === "archive" ? !project.archived : undefined)
    ) {
      setAction(null);
      setPhase("ready");
      setMessage(
        kind === "duplicate"
          ? "Project duplicated."
          : project.archived
            ? "Project reopened."
            : "Project archived.",
      );
      setVersion((value) => value + 1);
    } else if (outcome.kind === "rejected") {
      setPhase("ready");
      setMessage(outcome.message);
    } else {
      setPhase("unknown");
      setMessage(
        "The result could not be confirmed. Check the refreshed project list before making another change. Do not repeat a copy until you have checked for it.",
      );
      setVersion((value) => value + 1);
    }
  }
  const current = result?.tab === tab && result.version === version ? result : null;
  const items = current?.items?.filter((project) =>
    project.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <section
      className={`sp-home-projects sp-home-projects--${session.role.toLowerCase()}`}
      aria-label="Projects"
    >
      <div className="sp-page-heading sp-between">
        <div>
          {session.role === "Administrator" ? (
            <h1>All Projects</h1>
          ) : (
            <h2>{session.role === "Educator" ? "All Projects" : "Projects"}</h2>
          )}
          <p>Explore your projects and continue your classroom’s work.</p>
        </div>
        {showCreation && (
          <ProjectCreation
            session={session}
            active={active}
            onNavigationStateChange={onNavigationStateChange}
          />
        )}
      </div>
      <div className="sp-home-toolbar">
        <Tabs
          id="projects"
          label="Project status"
          value={tab}
          items={[
            { value: "active", label: "Projects" },
            { value: "archived", label: "Archived" },
          ]}
          onChange={(value) => {
            setTab(value);
            setSearch("");
          }}
        />
        <SearchField
          label="Search projects"
          value={search}
          onChange={setSearch}
          placeholder="Search projects"
          icon={session.role === "Educator" ? <Icon icon={searchIcon} width={18} /> : undefined}
        />
        <Button onClick={() => setVersion((value) => value + 1)}>Refresh</Button>
      </div>
      {message && !action && (
        <p role="status" className="sp-home-notice">
          {message}
        </p>
      )}
      <div id="projects-panel" role="tabpanel" aria-labelledby={`projects-${tab}`}>
        {!current ? (
          <PageState state="loading" onRetry={() => {}} />
        ) : current.items === null ? (
          <PageState state="error" onRetry={() => setVersion((value) => value + 1)} />
        ) : !items?.length ? (
          <p className="sp-list-empty" role="status">
            {search
              ? "No projects match your search."
              : tab === "archived"
                ? "No archived projects are available."
                : "No projects are available for your account yet."}
          </p>
        ) : (
          <ul className="sp-home-project-list">
            {items.map((project) => (
              <li key={project.projectId} className="sp-home-project-card">
                <img
                  className="sp-home-project-cover"
                  src={
                    session.role === "Creator"
                      ? (project.image?.url ?? projectCover(project.title))
                      : defaultProjectImage
                  }
                  alt=""
                />
                <div className="sp-home-project-copy">
                  <h2>{project.title}</h2>
                  <p className="sp-muted">Updated {new Date(project.updatedAt).toLocaleString()}</p>
                  <div className="sp-actions">
                    <Button
                      disabled={!project.permissions.canEdit || project.archived}
                      title={
                        project.archived
                          ? "Reopen this project before editing"
                          : !project.permissions.canEdit
                            ? "Editing is unavailable for this account"
                            : undefined
                      }
                      onClick={() => onOpenProject(project.projectId)}
                    >
                      {project.permissions.canEdit ? "Continue editing" : "Open project"}
                    </Button>
                    {project.permissions.canEdit && !project.archived && (
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setTitle(`${project.title} (copy)`.slice(0, 256));
                          setMessage("");
                          setAction({ project, kind: "duplicate" });
                        }}
                      >
                        Duplicate
                      </Button>
                    )}
                    {project.permissions.canManage && (
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setMessage("");
                          setAction({ project, kind: "archive" });
                        }}
                      >
                        {project.archived ? "Reopen" : "Archive"}
                      </Button>
                    )}
                    {session.role === "Administrator" &&
                      project.permissions.canManage &&
                      !project.archived && (
                        <Button variant="quiet" onClick={() => setGrantProject(project)}>
                          Manage access
                        </Button>
                      )}
                  </div>
                </div>
                <span className="sp-badge">
                  {project.archived
                    ? "Archived"
                    : project.permissions.canEdit
                      ? "Draft"
                      : "View only"}
                </span>
                {session.role === "Administrator" &&
                  !project.archived &&
                  project.permissions.canPublish && (
                    <a className="sp-button" href={`/publish?projectId=${project.projectId}`}>
                      Publish project
                    </a>
                  )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {grantProject && (
        <ProjectGrantEditor
          session={session}
          project={grantProject}
          active={active}
          onClose={() => setGrantProject(null)}
          onSaved={() => {
            setGrantProject(null);
            setMessage("Project access saved.");
            setVersion((value) => value + 1);
          }}
        />
      )}
      {action && active && (
        <Dialog
          {...(session.role === "Creator" ? { variant: "admin" as const } : {})}
          className={session.role === "Creator" ? "sp-creator-project-dialog" : ""}
          closeDisabled={phase === "pending"}
          title={
            action.kind === "duplicate"
              ? "Duplicate project"
              : action.project.archived
                ? "Reopen project"
                : "Archive project"
          }
          onClose={() => {
            if (phase !== "pending") {
              setAction(null);
              setPhase("ready");
            }
          }}
        >
          {phase === "unknown" ? (
            <p role="alert">{message}</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mutate();
              }}
            >
              <fieldset disabled={phase === "pending"} className="sp-home-fields">
                <legend className="sp-sr-only">Project change</legend>
                <p>{action.project.title}</p>
                {action.kind === "duplicate" ? (
                  <Field id="copy-title" label="Copy title">
                    <input
                      id="copy-title"
                      required
                      maxLength={256}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </Field>
                ) : (
                  <p>
                    {action.project.archived
                      ? "Reopen this project for its currently authorised editors."
                      : "Archive this project to stop editing. Its saved content will be kept."}
                  </p>
                )}
                {message && <p role="alert">{message}</p>}
                <Button
                  variant="primary"
                  type="submit"
                  disabled={action.kind === "duplicate" && !title.trim()}
                >
                  {phase === "pending" ? "Saving…" : "Confirm"}
                </Button>
              </fieldset>
            </form>
          )}
        </Dialog>
      )}
    </section>
  );
}
