import { Icon as UiIcon } from "@iconify/react/offline";
import faGlobe from "@iconify-icons/lucide/globe";
import faLock from "@iconify-icons/lucide/lock";
import faXmark from "@iconify-icons/lucide/x";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import type { AccountSession } from "../accounts/account-client";
import {
  createDashboardClient,
  type DashboardProject,
  type DashboardProjectDetails,
  type ProjectPublicationState,
} from "./dashboard-client";
import { ProjectModeration } from "./ProjectModeration";
import { ProjectProgress } from "./ProjectProgress";
import organisationIcon from "@iconify-icons/lucide/building-2";
import environmentIcon from "@iconify-icons/lucide/box";
import libraryIcon from "@iconify-icons/lucide/library";
import defaultProjectImage from "../home/assets/default-project-neutral.jpg";
import "./dashboard.css";

type Client = ReturnType<typeof createDashboardClient>;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Please try again.";

// Match the loaded card geometry while the dashboard waits for its authorised project list
const loadingProjects: DashboardProject[] = Array.from({ length: 3 }, (_, index) => ({
  projectId: `loading-${index}`,
  title: "Loading project",
  revision: 0,
  updatedAt: "",
  archived: false,
  organizationName: "Loading organisation",
  isPublic: false,
  permissions: { canEdit: false, canManage: false, canPublish: false },
}));

function ProjectCards({
  projects,
  onView,
  browser = false,
}: {
  projects: readonly DashboardProject[];
  onView: (project: DashboardProject) => void;
  browser?: boolean;
}) {
  return (
    <div className="admin-project-grid">
      {projects.map((project) => (
        <article className="admin-project-card" key={project.projectId}>
          <img className="admin-project-cover" src={defaultProjectImage} alt="" />
          <div className="admin-project-info">
            <div className="admin-project-title">
              <h3>{project.title}</h3>
              <span
                className={`admin-project-status admin-project-status--${project.isPublic ? "public" : "private"}`}
              >
                <UiIcon icon={project.isPublic ? faGlobe : faLock} aria-hidden="true" />
                {project.isPublic ? "Public" : "Private"}
              </span>
            </div>
            {browser && <p className="admin-project-organization">{project.organizationName}</p>}
            <Button
              variant="secondary"
              aria-label={`View Details for ${project.title}`}
              onClick={() => onView(project)}
            >
              View Details
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

function ProjectDetails({
  project,
  client,
  onClose,
  onPublicationChanged,
}: {
  project: DashboardProject;
  client: Client;
  onClose: () => void;
  onPublicationChanged: (state: ProjectPublicationState) => void;
}) {
  const [details, setDetails] = useState<DashboardProjectDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [assignmentIndex, setAssignmentIndex] = useState(0);
  const assignment = details?.assignments[assignmentIndex];
  const [publicationStates, setPublicationStates] = useState<
    Record<string, ProjectPublicationState>
  >({});
  const [publicationError, setPublicationError] = useState("");
  const [publicationAttempt, setPublicationAttempt] = useState(0);
  const currentPublication = publicationStates[project.projectId.toLowerCase()];
  const isPublic = currentPublication ? currentPublication.publicCount > 0 : project.isPublic;
  const publicationChanged = useCallback(
    (state: ProjectPublicationState) => {
      setPublicationStates((rows) => ({ ...rows, [state.projectId.toLowerCase()]: state }));
      onPublicationChanged(state);
    },
    [onPublicationChanged],
  );
  useEffect(() => {
    let disposed = false;

    // Keep organisation and student details bound to the account that opened this project
    void client.projectDetails(project.projectId).then(
      (value) => {
        if (!disposed) setDetails(value);
      },
      (error: unknown) => {
        if (!disposed) setDetailsError(errorMessage(error));
      },
    );
    return () => {
      disposed = true;
    };
  }, [client, project.projectId, attempt]);
  useEffect(() => {
    if (!details) {
      return;
    }
    let disposed = false;
    // Load the selected project and every linked student in bounded batches rather than per-row reads
    const ids = [
      project.projectId,
      ...details.assignments.flatMap((item) =>
        item.details.projects.map((student) => student.projectId),
      ),
    ];
    void client.publicationStates(ids).then(
      (states) => {
        if (!disposed) {
          setPublicationError("");
          setPublicationStates(states);
          for (const state of Object.values(states)) {
            onPublicationChanged(state);
          }
        }
      },
      (reason) => {
        if (!disposed) {
          setPublicationError(errorMessage(reason));
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [client, details, project.projectId, publicationAttempt, onPublicationChanged]);
  return (
    <section className="admin-panel admin-project-detail" aria-label="Project details">
      <div className="admin-project-view-heading">
        <div>
          <h1>Project Details</h1>
          <p>Review published experiences and control what visitors can explore.</p>
        </div>
        <Button
          className="sp-close-button"
          aria-label="Back"
          title="Close project details"
          onClick={onClose}
        >
          <UiIcon icon={faXmark} aria-hidden="true" />
        </Button>
      </div>
      <div className="admin-detail-columns">
        <div>
          <img className="admin-project-cover" src={defaultProjectImage} alt="" />
          <h2>{project.title}</h2>
          <div className="admin-project-moderation" aria-label="Project publication controls">
            <ProjectModeration
              projectId={project.projectId}
              client={client}
              state={currentPublication}
              onChanged={publicationChanged}
            />
          </div>
          {publicationError && (
            <div className="admin-moderation-retry">
              <p role="alert">{publicationError}</p>
              <Button
                onClick={() => {
                  setPublicationError("");
                  setPublicationAttempt((value) => value + 1);
                }}
              >
                Retry Publication Visibility
              </Button>
            </div>
          )}
          <dl className="admin-project-metadata">
            <dt>Organisation</dt>
            <dd>
              {details ? (
                <a href="/organisations">{details.organization.name}</a>
              ) : (
                <span role={detailsError ? "alert" : "status"}>
                  {detailsError || "Loading project details…"}
                </span>
              )}
            </dd>
            <>
              <dt>Created by</dt>
              <dd>
                {assignment?.details.creatorUserName
                  ? `@${assignment.details.creatorUserName}`
                  : "Username unavailable"}
              </dd>
              <dt>Class</dt>
              <dd>
                {details && details.assignments.length > 1 ? (
                  <select
                    className="admin-assignment-select"
                    aria-label="Class Assignment"
                    value={assignmentIndex}
                    onChange={(event) => setAssignmentIndex(Number(event.target.value))}
                  >
                    {details.assignments.map((item, index) => (
                      <option key={item.details.assignmentId} value={index}>
                        {item.className} — {item.details.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  (assignment?.className ?? (details ? "No class assigned" : "Loading…"))
                )}
              </dd>
            </>
            <dt>Status</dt>
            <dd
              className={`admin-project-visibility${isPublic ? " admin-project-visibility--public" : ""}`}
            >
              <UiIcon icon={isPublic ? faGlobe : faLock} aria-hidden="true" />
              {isPublic ? "Public" : "Private"}
            </dd>
          </dl>
          <div className="admin-assignment-description">
            <h3>Project Description</h3>
            <p
              className={!assignment?.details.description ? "admin-project-empty-value" : undefined}
            >
              {assignment?.details.description ||
                (details ? "No description provided." : "Loading…")}
            </p>
            <h3>Project Instructions</h3>
            <p
              className={
                !assignment?.details.instructions ? "admin-project-empty-value" : undefined
              }
            >
              {assignment?.details.instructions ||
                (details ? "No instructions provided." : "Loading…")}
            </p>
          </div>
        </div>
        {assignment ? (
          <ProjectProgress
            key={assignment.details.assignmentId}
            assignment={assignment}
            client={client}
            publicationStates={publicationStates}
            onPublicationChanged={publicationChanged}
          />
        ) : (
          <section className="admin-progress admin-progress-empty" aria-label="Student progress">
            <h2>Student Progress</h2>
            <p role={detailsError ? "alert" : "status"}>
              {detailsError ||
                (details
                  ? "No class assignments are linked to this project."
                  : "Loading student progress…")}
            </p>
            {detailsError && (
              <Button
                onClick={() => {
                  setDetailsError("");
                  setAttempt((value) => value + 1);
                }}
              >
                Retry
              </Button>
            )}
          </section>
        )}
      </div>
    </section>
  );
}

function ProjectResults({
  initialProjects,
  client,
  onClose,
  initialProjectId,
  onPublicationChanged,
}: {
  initialProjects: DashboardProject[];
  client: Client;
  onClose: () => void;
  initialProjectId?: string | undefined;
  onPublicationChanged: (state: ProjectPublicationState) => void;
}) {
  const [filter, setFilter] = useState<"all" | "private" | "public">("all");
  const [projects, setProjects] = useState<DashboardProject[]>(initialProjects);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<DashboardProject | null>(null);
  const publicationChanged = useCallback(
    (state: ProjectPublicationState) => {
      const update = (row: DashboardProject) =>
        row.projectId.toLowerCase() === state.projectId.toLowerCase()
          ? { ...row, isPublic: state.publicCount > 0 }
          : row;
      setProjects((rows) =>
        rows
          .filter(
            (row) =>
              row.projectId.toLowerCase() !== state.projectId.toLowerCase() ||
              state.publicationCount > 0,
          )
          .map(update),
      );
      setDetail((row) => (row ? update(row) : row));
      onPublicationChanged(state);
    },
    [onPublicationChanged],
  );
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        let cursor: string | null = null;
        const seen = new Set<string>();
        const rows = new Map<string, DashboardProject>();
        do {
          const page = await client.projects(20, cursor);
          if (disposed) return;
          for (const project of page.items) rows.set(project.projectId, project);
          setProjects([...rows.values()]);
          cursor = page.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 100))
            throw new Error(
              "The project list could not finish loading. Retry to search all projects.",
            );
          if (cursor) seen.add(cursor);
        } while (cursor);

        // Open organisation links only after the authorised list resolves the requested project
        if (initialProjectId) {
          let requested = rows.get(initialProjectId);
          if (!requested) {
            let archivedCursor: string | null = null;
            const archivedCursors = new Set<string>();
            do {
              const page = await client.projects(20, archivedCursor, true);
              if (disposed) {
                return;
              }
              requested = page.items.find(
                (row) => row.projectId.toLowerCase() === initialProjectId,
              );
              archivedCursor = page.nextCursor;
              if (
                archivedCursor &&
                (archivedCursors.has(archivedCursor) || archivedCursors.size >= 100)
              ) {
                throw new Error("The project list could not finish loading. Please try again.");
              }
              if (archivedCursor) {
                archivedCursors.add(archivedCursor);
              }
            } while (!requested && archivedCursor);
          }
          if (requested) {
            setDetail(requested);
          } else {
            setError("This project is unavailable to your account.");
          }
        }
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client, attempt, initialProjectId]);
  const privateCount = projects.filter((project) => !project.isPublic).length;
  const publicCount = projects.length - privateCount;
  const visible = projects.filter(
    (project) =>
      project.title.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === "all" || project.isPublic === (filter === "public")),
  );
  return (
    <>
      <section
        className="admin-panel admin-project-browser"
        aria-label="All Published Projects"
        hidden={detail !== null}
      >
        <div className="admin-project-view-heading">
          <div>
            <h1>All Published Projects</h1>
            <p>Review published experiences and control what visitors can explore.</p>
          </div>
          <SearchField
            label="Search published projects"
            value={query}
            onChange={setQuery}
            placeholder="Search published projects"
          />
          <Button
            className="sp-close-button"
            aria-label="Back"
            title="Close projects"
            onClick={onClose}
          >
            <UiIcon icon={faXmark} aria-hidden="true" />
          </Button>
        </div>
        <Tabs
          id="admin-project-filter"
          label="Project visibility"
          value={filter}
          onChange={setFilter}
          items={[
            {
              value: "all",
              label: !loading && !error ? `All Work (${projects.length})` : "All Work",
            },
            {
              value: "private",
              label: !loading && !error ? `Private (${privateCount})` : "Private",
            },
            {
              value: "public",
              label: !loading && !error ? `Public (${publicCount})` : "Public",
            },
          ]}
        />
        <div
          id="admin-project-filter-panel"
          role="tabpanel"
          aria-labelledby={`admin-project-filter-${filter}`}
        >
          <>
            {error && <p role="alert">{error}</p>}
            {error && (
              <Button
                onClick={() => {
                  setError("");
                  setLoading(true);
                  setAttempt((value) => value + 1);
                }}
              >
                Retry
              </Button>
            )}
            {(loading || visible.length > 0) && (
              <Skeleton
                loading={loading && projects.length === 0}
                label="Loading projects"
                className="admin-project-loading"
              >
                <ProjectCards
                  projects={loading && projects.length === 0 ? loadingProjects : visible}
                  onView={(project) => {
                    const url = new URL(location.href);
                    url.searchParams.set("projectId", project.projectId);
                    history.replaceState(null, "", url);
                    setDetail(project);
                  }}
                  browser
                />
              </Skeleton>
            )}
            {!loading && !error && !visible.length && (
              <p role="status" className="admin-project-empty">
                {query
                  ? "No matching projects in the loaded results."
                  : filter === "public"
                    ? "No public projects to show."
                    : filter === "private"
                      ? "No private projects to show."
                      : "No projects to show."}
              </p>
            )}
          </>
        </div>
      </section>
      {detail && (
        <ProjectDetails
          key={detail.projectId}
          project={detail}
          client={client}
          onPublicationChanged={publicationChanged}
          onClose={() => {
            const url = new URL(location.href);
            url.searchParams.delete("projectId");
            history.replaceState(null, "", url);
            if (url.searchParams.get("view") !== "projects") onClose();
            else setDetail(null);
          }}
        />
      )}
    </>
  );
}

function AddOrganization({
  client,
  onClose,
  onCreated,
}: {
  client: Client;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  async function submit() {
    if (busy.current || !name.trim()) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await client.createOrganization(name);
      onCreated(name.trim());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      title="Add Organisation"
      variant="admin"
      className="admin-add-organisation-dialog"
      onClose={() => {
        if (!busy.current) onClose();
      }}
    >
      <form
        className="admin-organisation-form"
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field id="organisation-name" label="Organisation name">
          <input
            id="organisation-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={256}
            required
            disabled={pending}
          />
        </Field>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
          {pending ? "Creating…" : "Create Organisation"}
        </Button>
      </form>
    </Dialog>
  );
}

export function AdminDashboard({
  session,
  onOpenOrganisations,
  initialProjects,
  onProjectsLoaded,
}: {
  session: AccountSession;
  onOpenOrganisations: () => void;
  initialProjects?: DashboardProject[] | undefined;
  onProjectsLoaded?: (projects: DashboardProject[]) => void;
}) {
  const [client] = useState(() => createDashboardClient(session.userId));
  const [projects, setProjects] = useState<DashboardProject[]>(initialProjects ?? []);
  const [loading, setLoading] = useState(initialProjects === undefined);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [initialProjectId] = useState(() => {
    const requested = new URLSearchParams(location.search).get("projectId");
    return requested && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requested)
      ? requested.toLowerCase()
      : undefined;
  });
  const [modal, setModal] = useState<"projects" | "organisation" | null>(
    initialProjectId || new URLSearchParams(location.search).get("view") === "projects"
      ? "projects"
      : null,
  );
  const [detail, setDetail] = useState<DashboardProject | null>(null);
  const publicationChanged = useCallback((state: ProjectPublicationState) => {
    const update = (row: DashboardProject) =>
      row.projectId.toLowerCase() === state.projectId.toLowerCase()
        ? { ...row, isPublic: state.publicCount > 0 }
        : row;
    setProjects((rows) =>
      rows
        .filter(
          (row) =>
            row.projectId.toLowerCase() !== state.projectId.toLowerCase() ||
            state.publicationCount > 0,
        )
        .map(update),
    );
    setDetail((row) => (row ? update(row) : row));
  }, []);
  useEffect(() => {
    let disposed = false;
    void client.projects().then(
      (page) => {
        if (!disposed) {
          setProjects(page.items);
          setLoading(false);
        }
      },
      (reason) => {
        if (!disposed) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [client, attempt, onProjectsLoaded]);
  useEffect(() => {
    if (!loading && !error) onProjectsLoaded?.(projects);
  }, [projects, loading, error, onProjectsLoaded]);
  if (modal === "projects")
    return (
      <div className="admin-dashboard">
        <ProjectResults
          initialProjects={projects}
          client={client}
          initialProjectId={initialProjectId}
          onPublicationChanged={publicationChanged}
          onClose={() => {
            const url = new URL(location.href);
            url.searchParams.delete("projectId");
            url.searchParams.delete("view");
            history.replaceState(null, "", url);
            setModal(null);
          }}
        />
      </div>
    );
  if (detail)
    return (
      <div className="admin-dashboard">
        <ProjectDetails
          key={detail.projectId}
          project={detail}
          client={client}
          onPublicationChanged={publicationChanged}
          onClose={() => {
            const url = new URL(location.href);
            url.searchParams.delete("projectId");
            history.replaceState(null, "", url);
            setDetail(null);
          }}
        />
      </div>
    );
  return (
    <div className="admin-dashboard">
      <div className="admin-greeting">
        <h1>Welcome Back, {session.displayName}</h1>
        <p>Manage what gets shared, who has access and the assets creators use.</p>
      </div>
      <section className="admin-panel admin-projects" aria-labelledby="admin-projects-heading">
        <div className="admin-section-heading">
          <div>
            <h2 id="admin-projects-heading">All Published Projects</h2>
            <p>Manage published projects and their public visibility.</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              const url = new URL(location.href);
              url.searchParams.set("view", "projects");
              history.replaceState(null, "", url);
              setModal("projects");
            }}
          >
            View All
          </Button>
        </div>
        {loading ? (
          <Skeleton loading label="Loading projects" className="admin-project-loading">
            <ProjectCards projects={loadingProjects} onView={() => {}} />
          </Skeleton>
        ) : error ? (
          <div className="admin-project-state">
            <p role="alert">{error}</p>
            <Button
              onClick={() => {
                setError("");
                setLoading(true);
                setAttempt((value) => value + 1);
              }}
            >
              Retry Projects
            </Button>
          </div>
        ) : projects.length ? (
          <ProjectCards projects={projects} onView={(project) => {
            const url = new URL(location.href);
            url.searchParams.set("projectId", project.projectId);
            history.replaceState(null, "", url);
            setDetail(project);
          }} />
        ) : (
          <p className="admin-project-state" role="status">
            No published projects yet. Projects will appear here once published.
          </p>
        )}
      </section>
      <div className="admin-management-grid">
        <section className="admin-panel" aria-labelledby="admin-organisations-heading">
          <div className="admin-section-heading">
            <div>
              <h2 id="admin-organisations-heading">Organisations &amp; Accounts</h2>
              <p>Manage organisations and the accounts associated with them in one place.</p>
            </div>
          </div>
          <div className="admin-directory-card">
            <div className="admin-directory-entry">
              <div className="admin-entry-identity">
                <span className="admin-entry-symbol">
                  <UiIcon icon={organisationIcon} width={24} aria-hidden="true" />
                </span>
                <div>
                  <h3>Organisation &amp; Accounts</h3>
                  <p>Manage organisations and the accounts associated with them in one place.</p>
                </div>
              </div>
              <div className="admin-entry-actions">
                <a
                  className="sp-button"
                  href="/organisations"
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    onOpenOrganisations();
                  }}
                >
                  <span className="sp-button-label">View Organisations</span>
                </a>
                <Button variant="primary" onClick={() => setModal("organisation")}>
                  + Add Organisations
                </Button>
              </div>
            </div>
          </div>
        </section>
        <section className="admin-panel" aria-labelledby="admin-assets-heading">
          <div className="admin-section-heading">
            <div>
              <h2 id="admin-assets-heading">Assets</h2>
              <p>Keep the building blocks of each museum ready to use.</p>
            </div>
          </div>
          <div className="admin-directory-card">
            {(
              [
                [
                  "environment",
                  "3D Environments",
                  "Manage the spaces available for museum projects.",
                  "View Environments",
                  "+ Add Environment",
                  environmentIcon,
                ],
                [
                  "model",
                  "Physical Asset Library",
                  "Curate the approved objects creators can place.",
                  "View Library",
                  "+ Add Item",
                  libraryIcon,
                ],
              ] as const
            ).map(([kind, title, description, view, add, icon]) => (
              <div className="admin-directory-entry" key={kind}>
                <div className="admin-entry-identity">
                  <span className="admin-entry-symbol">
                    <UiIcon icon={icon} width={24} aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </div>
                <div className="admin-entry-actions">
                  <a className="sp-button" href={kind === "environment" ? "/spaces" : "/assets"}>
                    <span className="sp-button-label">{view}</span>
                  </a>
                  <a
                    className="sp-button sp-button--primary"
                    href={kind === "environment" ? "/spaces?add=1" : "/assets?add=1"}
                  >
                    <span className="sp-button-label">{add}</span>
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {modal === "organisation" && (
        <AddOrganization
          client={client}
          onClose={() => setModal(null)}
          onCreated={() => {
            // Continue directly to the directory after the server confirms creation
            onOpenOrganisations();
          }}
        />
      )}
    </div>
  );
}
