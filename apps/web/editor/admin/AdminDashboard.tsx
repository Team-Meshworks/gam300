import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faImage } from "@fortawesome/free-solid-svg-icons";
import { assets } from "virtual:asset-catalogue";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import { SearchField } from "../../shared/ui/SearchField";
import type { AccountSession } from "../accounts/account-client";
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
                {project.archived ? "Archived" : "Draft"}
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
    <Dialog title="Project details" onClose={onClose}>
      <h3>{project.title}</h3>
      <dl className="admin-project-metadata">
        <dt>Status</dt>
        <dd>{project.archived ? "Archived" : "Draft"}</dd>
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
    </Dialog>
  );
}

function ProjectResults({ client, archived }: { client: Client; archived: boolean }) {
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<DashboardProject | null>(null);
  const pending = useRef(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    void client.projects(20, null, archived).then(
      (page) => {
        if (!disposed) {
          setProjects(page.items);
          setCursor(page.nextCursor);
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
  }, [client, archived, attempt]);
  async function more() {
    if (!cursor || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await client.projects(20, cursor, archived);
      if (page.nextCursor && (page.nextCursor === cursor || seen.current.has(page.nextCursor)))
        throw new Error("The project list could not finish loading. Close it and try again.");
      seen.current.add(cursor);
      setProjects((rows) => [
        ...new Map([...rows, ...page.items].map((row) => [row.projectId, row])).values(),
      ]);
      setCursor(page.nextCursor);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }
  const visible = projects.filter((project) =>
    project.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="admin-project-browser">
      <SearchField
        label="Search loaded projects"
        value={query}
        onChange={setQuery}
        placeholder="Search projects by title"
      />
      {error && <p role="alert">{error}</p>}
      {!projects.length && error && (
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
      {cursor && (
        <Button disabled={loading} onClick={() => void more()}>
          {loading ? "Loading…" : "Load more projects"}
        </Button>
      )}
      {detail && <ProjectDetails project={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ProjectsDialog({ client, onClose }: { client: Client; onClose: () => void }) {
  const [archived, setArchived] = useState(false);
  return (
    <Dialog title="All Projects" variant="wide" onClose={onClose}>
      <Field id="admin-project-status" label="Project status">
        <select
          id="admin-project-status"
          value={String(archived)}
          onChange={(event) => setArchived(event.target.value === "true")}
        >
          <option value="false">Current projects</option>
          <option value="true">Archived projects</option>
        </select>
      </Field>
      <ProjectResults key={String(archived)} client={client} archived={archived} />
    </Dialog>
  );
}

function AssetLibrary({ kind, onClose }: { kind: "environment" | "model"; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const entries = assets.filter(
    (asset) => asset.kind === kind && asset.name.toLowerCase().includes(query.trim().toLowerCase()),
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
      {!entries.length && <p role="status">No matching assets.</p>}
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
      {modal === "projects" && <ProjectsDialog client={client} onClose={() => setModal(null)} />}
      {(modal === "environment" || modal === "model") && (
        <AssetLibrary kind={modal} onClose={() => setModal(null)} />
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
      {detail && <ProjectDetails project={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
