import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faImage } from "@fortawesome/free-solid-svg-icons";
import { assets } from "virtual:asset-catalogue";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { AccountSession } from "../accounts/account-client";
import { readServerAssets } from "../persistence/server-assets";
import { belongsInAssetPicker } from "../ui/asset-selection";
import { createDashboardClient, type DashboardProject } from "./dashboard-client";
import organisationIcon from "./assets/organisation.svg";
import environmentIcon from "./assets/environment.svg";
import libraryIcon from "./assets/library.svg";
import "./dashboard.css";

type Client = ReturnType<typeof createDashboardClient>;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Please try again.";

function ProjectCards({
  projects,
  onView,
}: {
  projects: readonly DashboardProject[];
  onView: (project: DashboardProject) => void;
}) {
  return (
    <div className="admin-project-grid">
      {projects.map((project) => (
        <article className="admin-project-card" key={project.projectId}>
          <div className="admin-project-cover">
            <FontAwesomeIcon icon={faImage} aria-hidden="true" />
            <span>No cover image</span>
          </div>
          <div className="admin-project-info">
            <div className="admin-project-title">
              <h3>{project.title}</h3>
              <span className="admin-project-status">
                {project.archived ? "Archived" : "Current"}
              </span>
            </div>
            <Button
              aria-label={`View details for ${project.title}`}
              onClick={() => onView(project)}
            >
              View details
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

function ProjectDetails({ project, onClose }: { project: DashboardProject; onClose: () => void }) {
  return (
    <section className="admin-panel admin-project-detail" aria-label="Project details">
      <div className="admin-project-view-heading">
        <div>
          <h1>Project details</h1>
          <p>Review this project's available details.</p>
        </div>
        <Button aria-label="Back" onClick={onClose}>
          ×
        </Button>
      </div>
      <div className="admin-detail-columns">
        <div>
          <div className="admin-project-cover">
            <FontAwesomeIcon icon={faImage} aria-hidden="true" />
            <span>No cover image</span>
          </div>
          <h2>{project.title}</h2>
          <dl className="admin-project-metadata">
            <dt>Status</dt>
            <dd>{project.archived ? "Archived" : "Current"}</dd>
            <dt>Revision</dt>
            <dd>{project.revision}</dd>
            <dt>Updated</dt>
            <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
          </dl>
          {project.permissions.canEdit && !project.archived && (
            <a
              className="sp-button sp-button--primary"
              href={`/?projectId=${encodeURIComponent(project.projectId)}`}
            >
              Open project
            </a>
          )}
        </div>
        <div className="admin-detail-unavailable">
          <h2>Project progress</h2>
          <p>Student progress and publication controls are unavailable for this project.</p>
        </div>
      </div>
    </section>
  );
}

function ProjectResults({ client, onClose }: { client: Client; onClose: () => void }) {
  const archived = false;
  const [filter, setFilter] = useState<"all" | "private" | "public">("all");
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<DashboardProject | null>(null);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        let cursor: string | null = null;
        const seen = new Set<string>();
        const rows = new Map<string, DashboardProject>();
        do {
          const page = await client.projects(20, cursor, archived);
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
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client, archived, attempt]);
  const visible = projects.filter((project) =>
    project.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <section
        className="admin-panel admin-project-browser"
        aria-label="All Projects"
        hidden={detail !== null}
      >
        <div className="admin-project-view-heading">
          <div>
            <h1>All Projects</h1>
            <p>Browse projects across your organisations.</p>
          </div>
          <SearchField
            label="Search all projects"
            value={query}
            onChange={setQuery}
            placeholder="Search all projects"
          />
          <Button aria-label="Back" onClick={onClose}>
            ×
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
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
        <div
          id="admin-project-filter-panel"
          role="tabpanel"
          aria-labelledby={`admin-project-filter-${filter}`}
        >
          {filter !== "all" ? (
            <p role="status">
              Project visibility is unavailable. Public and private projects cannot be filtered yet.
            </p>
          ) : (
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
              <ProjectCards projects={visible} onView={setDetail} />
              {loading && <p role="status">Loading projects…</p>}
              {!loading && !error && !visible.length && (
                <p role="status">
                  {query ? "No matching projects in the loaded results." : "No projects to show."}
                </p>
              )}
            </>
          )}
        </div>
      </section>
      {detail && <ProjectDetails project={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function AssetLibrary({
  kind,
  onClose,
  session,
}: {
  kind: "environment" | "model";
  onClose: () => void;
  session: AccountSession;
}) {
  const [query, setQuery] = useState("");
  const [catalogue, setCatalogue] = useState<readonly CatalogueAsset[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readServerAssets(session.userId, controller.signal).then(
      (approved) => {
        if (!controller.signal.aborted)
          setCatalogue([...(session.developmentAssetsAllowed ? assets : []), ...approved]);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [session.userId, session.developmentAssetsAllowed, attempt]);
  const entries = (catalogue ?? []).filter(
    (asset) =>
      belongsInAssetPicker(asset, kind === "environment") &&
      asset.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Dialog
      title={kind === "environment" ? "3D Environments" : "Physical Asset Library"}
      variant="wide"
      onClose={onClose}
    >
      <p>Assets currently available to creators.</p>
      <SearchField
        label="Search assets"
        value={query}
        onChange={setQuery}
        placeholder="Search by name"
      />
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Retry assets
          </Button>
        </>
      )}
      {!catalogue && !error && <p role="status">Loading approved assets…</p>}
      <div className="admin-project-grid">
        {entries.map((asset) => (
          <article className="admin-project-card" key={asset.id}>
            {asset.thumbnail ? (
              <img className="admin-asset-cover" src={asset.thumbnail} alt="" />
            ) : (
              <div className="admin-project-cover">
                <FontAwesomeIcon icon={faImage} aria-hidden="true" />
                <span>No preview image</span>
              </div>
            )}
            <div className="admin-project-info">
              <h3>{asset.name}</h3>
              <p className="sp-hint">
                {asset.category ?? (kind === "environment" ? "Environment" : "3D model")}
              </p>
            </div>
          </article>
        ))}
      </div>
      {catalogue && !entries.length && <p role="status">No matching assets.</p>}
    </Dialog>
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
      title="Add organisation"
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
          {pending ? "Creating…" : "Create organisation"}
        </Button>
      </form>
    </Dialog>
  );
}

export function AdminDashboard({ session }: { session: AccountSession }) {
  const [client] = useState(() => createDashboardClient(session.userId));
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"projects" | "organisation" | "environment" | "model" | null>(
    null,
  );
  const [detail, setDetail] = useState<DashboardProject | null>(null);
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
  }, [client, attempt]);
  if (modal === "projects")
    return (
      <div className="admin-dashboard">
        <ProjectResults client={client} onClose={() => setModal(null)} />
      </div>
    );
  if (detail)
    return (
      <div className="admin-dashboard">
        <ProjectDetails project={detail} onClose={() => setDetail(null)} />
      </div>
    );
  return (
    <div className="admin-dashboard">
      <div className="admin-greeting">
        <h1>Welcome Back, {session.displayName}</h1>
        <p>Manage what gets shared, who has access and the assets creators use.</p>
        <a className="sp-button sp-button--primary" href="/home">
          Open project workspace
        </a>
      </div>
      {notice && (
        <p className="admin-notice" role="status">
          {notice} <a href="/accounts">View organisations</a>
        </p>
      )}
      <section className="admin-panel admin-projects" aria-labelledby="admin-projects-heading">
        <div className="admin-section-heading">
          <div>
            <h2 id="admin-projects-heading">All Projects</h2>
            <p>Browse projects across your organisations.</p>
          </div>
          <Button variant="primary" onClick={() => setModal("projects")}>
            View All Projects
          </Button>
        </div>
        {loading ? (
          <p className="admin-project-state" role="status">
            Loading projects…
          </p>
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
              Retry projects
            </Button>
          </div>
        ) : projects.length ? (
          <ProjectCards projects={projects} onView={setDetail} />
        ) : (
          <p className="admin-project-state" role="status">
            No projects yet. Projects will appear here when your organisations create them.
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
                  <img src={organisationIcon} alt="" />
                </span>
                <div>
                  <h3>Organisation &amp; Accounts</h3>
                  <p>Manage organisations and the accounts associated with them in one place.</p>
                </div>
              </div>
              <div className="admin-entry-actions">
                <a className="sp-button" href="/accounts">
                  View Organisations
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
              <p>Keep the shared building blocks of each museum ready to use.</p>
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
                  "+ Add environment",
                  environmentIcon,
                ],
                [
                  "model",
                  "Physical Asset Library",
                  "Curate the approved objects creators can place.",
                  "View Library",
                  "+ Add item",
                  libraryIcon,
                ],
              ] as const
            ).map(([kind, title, description, view, add, icon]) => (
              <div className="admin-directory-entry" key={kind}>
                <div className="admin-entry-identity">
                  <span className="admin-entry-symbol">
                    <img src={icon} alt="" />
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </div>
                <div className="admin-entry-actions">
                  <Button onClick={() => setModal(kind)}>{view}</Button>
                  <Button variant="primary" disabled aria-describedby="admin-upload-note">
                    {add}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="admin-upload-note" id="admin-upload-note">
            Asset uploads are not available yet.
          </p>
        </section>
      </div>
      {(modal === "environment" || modal === "model") && (
        <AssetLibrary kind={modal} onClose={() => setModal(null)} session={session} />
      )}
      {modal === "organisation" && (
        <AddOrganization
          client={client}
          onClose={() => setModal(null)}
          onCreated={(name) => {
            setModal(null);
            setNotice(`${name} was created. You can now add its accounts.`);
          }}
        />
      )}
    </div>
  );
}
