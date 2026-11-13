import { Icon as UiIcon } from "@iconify/react/offline";
import faGlobe from "@iconify-icons/lucide/globe";
import faLock from "@iconify-icons/lucide/lock";
import faEye from "@iconify-icons/lucide/eye";
import faEyeSlash from "@iconify-icons/lucide/eye-off";
import faTrashCan from "@iconify-icons/lucide/trash-2";
import faXmark from "@iconify-icons/lucide/x";
import { useState, type ReactNode } from "react";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { playUiSound } from "../audio/ui-sounds";
import { AccountList, type AccountActions } from "./AccountList";
import type { DirectoryOrganization } from "./directory";
import defaultProjectImage from "../home/assets/default-project-neutral.jpg";
import "./directory.css";

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Supply only organizations/accounts the current user is authorized to inspect
export function OrganizationDirectory({
  organizations,
  onPreview,
  selectedId,
  onSelect,
  onDelete,
  onToggleActive,
  busy = false,
  accountActions,
  loading,
  detailError,
  projectError,
  administration = false,
  searchQuery,
  onSearch,
  searching = false,
  searchError,
}: {
  organizations: readonly DirectoryOrganization[];
  onPreview: (title: string, body: ReactNode) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete?: (id: string) => void;
  onToggleActive?: (id: string) => void;
  busy?: boolean;
  accountActions?: AccountActions;
  loading?: boolean;
  detailError?: string;
  projectError?: string;
  administration?: boolean;
  searchQuery?: string;
  onSearch?: (query: string) => void;
  searching?: boolean;
  searchError?: string;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const query = searchQuery ?? localQuery;
  const [projectQuery, setProjectQuery] = useState("");
  const [projectVisibility, setProjectVisibility] = useState<"All" | "Public" | "Private">("All");
  const organization = organizations.find((item) => item.id === selectedId);
  const visibleProjects =
    organization?.projects.filter(
      (project) =>
        project.title.toLowerCase().includes(projectQuery.trim().toLowerCase()) &&
        (!administration ||
          projectVisibility === "All" ||
          (projectVisibility === "Public"
            ? project.isPublic === true
            : project.isPublic === false)),
    ) ?? [];
  if (organization) {
    return (
      <div className={`sp-directory${administration ? " sp-directory--administration" : ""}`}>
        {!administration && (
          <div>
            <Button
              onClick={() => {
                onSelect(null);
                playUiSound("goingBack");
              }}
            >
              All organisations
            </Button>
          </div>
        )}
        <div className="sp-organization-detail">
          <div className="sp-organization-detail-left">
            <section className="sp-card sp-organization-identity">
              <div className="sp-account">
                <Avatar
                  name={organization.name}
                  {...(administration
                    ? { initials: Array.from(organization.name.trim())[0] ?? "" }
                    : {})}
                />
                <h2>{organization.name}</h2>
              </div>
              <div className="sp-actions">
                {administration && onToggleActive && (
                  <Button disabled={busy} onClick={() => onToggleActive(organization.id)}>
                    <UiIcon icon={organization.isActive ? faEyeSlash : faEye} aria-hidden="true" />
                    <span className="sp-button-label">
                      {organization.isActive ? "Hide" : "Show"}
                    </span>
                  </Button>
                )}
                {!administration && (
                  <Button disabled title="Hiding organisations is not available yet">
                    Hide
                  </Button>
                )}
                {onDelete && (
                  <Button
                    className="sp-button--danger"
                    disabled={busy}
                    aria-label="Delete organisation"
                    onClick={() => onDelete(organization.id)}
                  >
                    {administration && <UiIcon icon={faTrashCan} aria-hidden="true" />}
                    <span className="sp-button-label">Delete</span>
                  </Button>
                )}
              </div>
              {!accountActions && (
                <dl className="sp-summary">
                  <dt>Projects</dt>
                  <dd>{organization.projects.length}</dd>
                  <dt>Teachers</dt>
                  <dd>{organization.accounts.filter((item) => item.role === "Teachers").length}</dd>
                  <dt>Students</dt>
                  <dd>{organization.accounts.filter((item) => item.role === "Students").length}</dd>
                </dl>
              )}
            </section>
            <section className="sp-card sp-organization-projects">
              <SearchField
                label="Search projects"
                value={projectQuery}
                onChange={setProjectQuery}
                placeholder="Search projects"
              />
              {administration ? (
                <Tabs
                  id="organisation-projects"
                  label="Project visibility"
                  value={projectVisibility}
                  onChange={setProjectVisibility}
                  items={[
                    { value: "All", label: "All Projects" },
                    { value: "Public", label: "Public" },
                    { value: "Private", label: "Private" },
                  ]}
                />
              ) : (
                <h3>All Projects</h3>
              )}
              <div
                className="sp-organization-project-list"
                {...(administration
                  ? {
                      role: "tabpanel",
                      id: "organisation-projects-panel",
                      "aria-labelledby": `organisation-projects-${projectVisibility}`,
                      tabIndex: 0,
                    }
                  : {})}
              >
                {loading ? (
                  <p role="status">Loading organisation…</p>
                ) : projectError ? (
                  <p role="alert">{projectError}</p>
                ) : (
                  visibleProjects.map((project) => (
                    <article className="sp-directory-project" key={project.id}>
                      <img src={project.cover || defaultProjectImage} alt="" />
                      <div className="sp-directory-project-body">
                        <div className="sp-directory-project-heading">
                          <h4>{project.title}</h4>
                          {administration && typeof project.isPublic === "boolean" && (
                            <span
                              className={`sp-directory-project-visibility${project.isPublic ? " is-public" : ""}`}
                            >
                              <UiIcon
                                icon={project.isPublic ? faGlobe : faLock}
                                aria-hidden="true"
                              />
                              {project.isPublic ? "Public" : "Private"}
                            </span>
                          )}
                        </div>
                        <p className="sp-hint">
                          {administration
                            ? organization.name
                            : `${project.creator ? `${project.creator} · ` : ""}${project.status}`}
                        </p>
                        {administration ? (
                          <a
                            className="sp-button sp-button--primary"
                            href={`/admin/dashboard?projectId=${encodeURIComponent(project.id)}`}
                          >
                            View Details
                          </a>
                        ) : (
                          <Button
                            onClick={() =>
                              onPreview(
                                "Project details",
                                <>
                                  <h3>{project.title}</h3>
                                  {project.creator && <p>Creator: {project.creator}</p>}
                                  <p>Status: {project.status}</p>
                                  <p className="sp-hint">
                                    Read-only directory details. Project editing and publication are
                                    unavailable here.
                                  </p>
                                </>,
                              )
                            }
                          >
                            View project
                          </Button>
                        )}
                      </div>
                    </article>
                  ))
                )}
                {!loading && !projectError && !visibleProjects.length && (
                  <p role="status">
                    {organization.projects.length
                      ? "No matching projects."
                      : "No projects in this organisation."}
                  </p>
                )}
              </div>
            </section>
          </div>
          <AccountList
            key={organization.id}
            administration={administration}
            onClose={
              administration
                ? () => {
                    onSelect(null);
                    playUiSound("goingBack");
                  }
                : undefined
            }
            accounts={organization.accounts}
            organizationName={organization.name}
            onPreview={onPreview}
            actions={accountActions}
            loading={Boolean(loading)}
            error={detailError}
          />
        </div>
      </div>
    );
  }
  // Server search can match a member even when the organisation name differs from the query
  const visible =
    searching || searchError
      ? []
      : onSearch
        ? organizations
        : organizations.filter((item) =>
            item.name.toLowerCase().includes(query.trim().toLowerCase()),
          );
  return (
    <section
      className={`sp-directory sp-organization-overview${administration ? " sp-directory--administration" : ""}`}
    >
      <div className="sp-organization-overview-heading">
        <div>
          <h1>All Organisations</h1>
          <p className="sp-hint">
            {administration
              ? "Review published experiences and control what visitors can explore."
              : "Browse organisations and inspect their projects and accounts."}
          </p>
        </div>
        <SearchField
          label="Search organisations"
          value={query}
          onChange={onSearch ?? setLocalQuery}
          placeholder={
            administration
              ? "Search all organisations and accounts"
              : "Search organisations by name"
          }
        />
        <a
          className={`sp-button sp-directory-close${administration ? " sp-close-button" : ""}`}
          href="/admin/dashboard"
          aria-label="Close organisations"
        >
          <UiIcon icon={faXmark} aria-hidden="true" />
        </a>
      </div>
      <h2>All Organisations</h2>
      <div className="sp-organization-grid">
        {visible.map((item) => (
          <article key={item.id} className="sp-card sp-organization-card">
            <div className="sp-account">
              <Avatar
                name={item.name}
                {...(administration ? { initials: Array.from(item.name.trim())[0] ?? "" } : {})}
              />
              <h3>{item.name}</h3>
            </div>
            {administration ? (
              item.counts ? (
                <div className="sp-organization-counts sp-hint" aria-label="Organisation totals">
                  <span>{countLabel(item.counts.projects, "Project")}</span>
                  <span>{countLabel(item.counts.facilitators, "Facilitator")}</span>
                  <span>{countLabel(item.counts.creators, "Creator")}</span>
                </div>
              ) : (
                <p className="sp-hint">Totals unavailable</p>
              )
            ) : accountActions ? (
              <p className="sp-hint">{item.description}</p>
            ) : (
              <p className="sp-hint">
                {countLabel(item.projects.length, "project")} ·{" "}
                {countLabel(
                  item.accounts.filter((account) => account.role === "Teachers").length,
                  "teacher",
                )}{" "}
                ·{" "}
                {countLabel(
                  item.accounts.filter((account) => account.role === "Students").length,
                  "student",
                )}
              </p>
            )}
            <Button
              variant="primary"
              aria-label={`Open ${item.name}`}
              onClick={() => {
                setProjectQuery("");
                setProjectVisibility("All");
                onSelect(item.id);
              }}
            >
              View Organisation
            </Button>
          </article>
        ))}
        {!searching && !searchError && !visible.length && (
          <p role="status" className="sp-list-empty">
            No matching organisations. Try another name.
          </p>
        )}
      </div>
      {searching && <p role="status">Searching organisations…</p>}
      {searchError && <p role="alert">{searchError}</p>}
    </section>
  );
}
