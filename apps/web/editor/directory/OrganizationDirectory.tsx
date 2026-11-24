import { adminPublishedReturnUrl } from "../projects/progress-navigation";
import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { SkeletonBox } from "skullet/react";
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
  onCreate,
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
  onRetrySearch,
}: {
  organizations: readonly DirectoryOrganization[];
  onPreview: (title: string, body: ReactNode) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete?: (id: string) => void;
  onCreate?: () => void;
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
  onRetrySearch?: () => void;
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
  if (administration && selectedId && !organization && searching) {
    return (
      <div
        className="sp-directory sp-directory--administration sp-panel-surface sp-organization-detail-loading"
        role="status"
        aria-label="Loading organisation"
        aria-busy="true"
      >
        <div className="sp-organization-detail-loading-left" aria-hidden="true">
          <div className="sp-organization-detail-loading-identity">
            <SkeletonBox width={50} height={50} radius={25} />
            <SkeletonBox width="55%" height={24} radius={4} />
          </div>
          <div className="sp-organization-detail-loading-projects">
            <SkeletonBox width="100%" height={45} radius={24} />
            <SkeletonBox width="70%" height={18} radius={4} />
          </div>
        </div>
        <div className="sp-organization-detail-loading-accounts" aria-hidden="true">
          <SkeletonBox width="100%" height={45} radius={24} />
          <SkeletonBox width="65%" height={18} radius={4} />
        </div>
      </div>
    );
  }
  if (organization) {
    return (
      <div
        className={`sp-directory${administration ? " sp-directory--administration sp-panel-surface" : ""}`}
      >
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
                  <Button
                    className="sp-hide-action"
                    disabled={busy}
                    onClick={() => onToggleActive(organization.id)}
                  >
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
                label={administration ? "Search published projects" : "Search projects"}
                value={projectQuery}
                onChange={setProjectQuery}
                placeholder={administration ? "Search published projects" : "Search projects"}
              />
              {administration ? (
                <Tabs
                  id="organisation-projects"
                  label="Project visibility"
                  value={projectVisibility}
                  onChange={setProjectVisibility}
                  items={[
                    { value: "All", label: "All Published" },
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
                  <LoadingSkeleton label="Loading organisation" layout="cards" />
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
                      ? administration
                        ? "No matching published projects."
                        : "No matching projects."
                      : administration
                        ? "No published projects in this organisation."
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
  const visible = searchError
    ? []
    : onSearch
      ? organizations
      : organizations.filter((item) =>
          item.name.toLowerCase().includes(query.trim().toLowerCase()),
        );
  return (
    <section
      className={`sp-directory sp-organization-overview${administration ? " sp-directory--administration sp-panel-surface" : ""}`}
    >
      <div
        className={`sp-organization-overview-heading${administration ? " sp-admin-page-heading" : ""}`}
      >
        <div>
          <h1>All Organisations</h1>
          <p className="sp-hint">
            {administration
              ? "Manage organisations and their accounts."
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
          href={
            new URLSearchParams(location.search).has("returnProjectId")
              ? adminPublishedReturnUrl(new URLSearchParams(location.search))
              : "/admin/dashboard"
          }
          aria-label="Close organisations"
        >
          <UiIcon icon={faXmark} aria-hidden="true" />
        </a>
      </div>
      <div className="sp-actions sp-organization-overview-toolbar">
        <h2>
          <span className="sp-tab-content">
            <span>All Organisations</span>
          </span>
        </h2>
        {administration && onCreate && (
          <Button variant="primary" disabled={busy} onClick={onCreate}>
            Add Organisation
          </Button>
        )}
      </div>
      <div className="sp-organization-grid">
        {!searching && searchError && (
          <div className="sp-list-empty" role="alert">
            <p>{searchError}</p>
            {onRetrySearch && <Button onClick={onRetrySearch}>Retry search</Button>}
          </div>
        )}
        {searching && !visible.length && (
          <div
            className="sp-organization-loading"
            role="status"
            aria-label="Loading organisations"
            aria-busy="true"
          >
            {[0, 1].map((index) => (
              <div className="sp-organization-placeholder" key={index} aria-hidden="true">
                <SkeletonBox width={50} height={50} radius={25} />
                <div>
                  <SkeletonBox width="70%" height={22} radius={4} />
                  <SkeletonBox width="45%" height={22} radius={4} />
                </div>
                <SkeletonBox width={130} height={40} radius={20} />
              </div>
            ))}
          </div>
        )}
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
                  <span>{countLabel(item.counts.projects, "Published Project")}</span>
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
              className="sp-catalogue-action"
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
          <div className="sp-list-empty">
            <p role="status">
              {query.trim()
                ? "No matching organisations. Try another name."
                : administration && onCreate
                  ? "No organisations yet. Add the first organisation to get started."
                  : "No organisations yet."}
            </p>
            {query.trim() && (
              <Button onClick={() => (onSearch ?? setLocalQuery)("")}>Clear search</Button>
            )}
          </div>
        )}
      </div>
      {searching && visible.length > 0 && (
        <span role="status" className="sp-sr-only">
          Searching organisations
        </span>
      )}
    </section>
  );
}
