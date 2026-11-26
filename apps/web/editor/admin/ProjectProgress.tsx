import { SelectionToggle } from "../../shared/ui/SelectionToggle";
import { Icon as UiIcon } from "@iconify/react/offline";
import faGlobe from "@iconify-icons/lucide/globe";
import { SelectionBar } from "../../shared/ui/SelectionBar";
import faLock from "@iconify-icons/lucide/lock";
import { useState } from "react";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import {
  createDashboardClient,
  type DashboardAssignment,
  type ProjectPublicationState,
} from "./dashboard-client";
import { ProjectModeration } from "./ProjectModeration";

export function ProjectProgress({
  assignment,
  client,
  publicationStates,
  onPublicationChanged,
}: {
  assignment: DashboardAssignment;
  client: ReturnType<typeof createDashboardClient>;
  publicationStates: Record<string, ProjectPublicationState>;
  onPublicationChanged: (state: ProjectPublicationState) => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkError, setBulkError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "public" | "private">("all");
  const students = assignment.details.projects.filter((student) => {
    const state = publicationStates[student.projectId.toLowerCase()];
    return state ? state.publicationCount > 0 : student.published === true;
  });
  const publicProjects = students.filter((row) => {
    const state = publicationStates[row.projectId.toLowerCase()];
    return state ? state.publicCount > 0 : row.isPublic === true;
  });
  const privateProjects = students.filter((row) => {
    const state = publicationStates[row.projectId.toLowerCase()];
    return state ? state.publicCount === 0 : row.isPublic === false;
  });
  const rows = (
    filter === "all" ? students : filter === "public" ? publicProjects : privateProjects
  ).filter((row) =>
    `${row.studentName ?? ""} ${row.studentUserName ?? ""}`
      .toLocaleLowerCase()
      .includes(search.trim().replace(/^@/, "").toLocaleLowerCase()),
  );
  const ids = rows.map((row) => row.projectId);
  const picked = selected.filter((id) => ids.includes(id));
  const allSelected = ids.length > 0 && picked.length === ids.length;
  const states = picked.map((id) => publicationStates[id.toLowerCase()]);
  const aggregate =
    picked.length && states.every(Boolean)
      ? {
          projectId: assignment.details.assignmentId,
          publicationCount: states.reduce((sum, state) => sum + state!.publicationCount, 0),
          hiddenCount: states.reduce((sum, state) => sum + state!.hiddenCount, 0),
          publicCount: states.reduce((sum, state) => sum + state!.publicCount, 0),
        }
      : undefined;
  async function refreshSelected(action: "hide" | "show" | "delete") {
    setBulkError("");
    try {
      const states = await client.publicationStates(
        assignment.details.projects.map((row) => row.projectId),
      );
      for (const state of Object.values(states)) onPublicationChanged(state);
    } catch {
      setBulkError(
        "Publication visibility could not be refreshed. Reload before making another change.",
      );
    }
    setSelected([]);
    if (action === "delete") setSelecting(false);
  }
  return (
    <section className="admin-progress" aria-label="Published student projects">
      <div className="admin-progress-controls">
        <SearchField
          label="Search students"
          placeholder="Search students by name or account"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setSelected([]);
          }}
        />
        <div className="admin-project-selection-toolbar">
          <Tabs
            id="admin-student-status"
            label="Published project visibility"
            value={filter}
            onChange={(value) => {
              setFilter(value);
              setSelected([]);
            }}
            items={[
              { value: "all", label: `All Published (${students.length})` },
              { value: "public", label: `Public (${publicProjects.length})` },
              {
                value: "private",
                label: `Private (${privateProjects.length})`,
              },
            ]}
          />
          <SelectionToggle
            label="Select projects"
            title="Select multiple projects"
            selected={selecting}
            disabled={!selecting && !ids.length}
            onClick={() => {
              setSelecting(!selecting);
              setSelected([]);
            }}
          />
        </div>
      </div>
      {bulkError && <p role="alert">{bulkError}</p>}
      <div
        id="admin-student-status-panel"
        role="tabpanel"
        aria-labelledby={`admin-student-status-${filter}`}
        className="admin-progress-list"
      >
        {rows.map((student) => {
          const parts = /^(.*) \(([^()]*)\)$/.exec(student.studentName ?? "");
          const name = parts?.[1] ?? student.studentName ?? "Student";
          const account = student.studentUserName ?? parts?.[2];
          const publicationState = publicationStates[student.projectId.toLowerCase()];
          const isPublic = publicationState ? publicationState.publicCount > 0 : student.isPublic;
          const initials = name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0])
            .join("");
          return (
            <article
              className={`admin-progress-row${picked.includes(student.projectId) ? " is-selected" : ""}`}
              key={student.projectId}
            >
              {selecting && (
                <input
                  className="sp-row-select-input"
                  type="checkbox"
                  aria-label={`Select project by ${name}`}
                  checked={picked.includes(student.projectId)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, student.projectId]
                        : current.filter((id) => id !== student.projectId),
                    )
                  }
                />
              )}
              <div className="admin-student-identity">
                <span
                  className={selecting ? "sp-selection-marker" : "admin-student-avatar"}
                  aria-hidden="true"
                >
                  {selecting ? null : initials}
                </span>
                <div>
                  <strong>{name}</strong>
                  {account && <span>@{account}</span>}
                </div>
              </div>
              <dl className="admin-student-status">
                <dt>Publish Status</dt>
                <dd
                  className={isPublic === true ? "admin-status-approved" : "admin-status-private"}
                >
                  <UiIcon icon={isPublic === true ? faGlobe : faLock} aria-hidden="true" />
                  {isPublic === undefined ? "Unavailable" : isPublic ? "Public" : "Private"}
                </dd>
              </dl>
              <div className="admin-student-action-slot">
                <fieldset
                  className="admin-student-actions"
                  disabled={selecting}
                  aria-label={`Publication controls for ${name}`}
                >
                  <a
                    className="sp-button sp-button--primary"
                    title="View latest published version"
                    aria-disabled={selecting || undefined}
                    tabIndex={selecting ? -1 : undefined}
                    href={
                      selecting
                        ? undefined
                        : `/?${new URLSearchParams({
                            projectId: student.projectId,
                            view: "published",
                            returnProjectId:
                              new URLSearchParams(location.search).get("projectId") ?? "",
                            returnView: new URLSearchParams(location.search).get("view") ?? "",
                          })}`
                    }
                  >
                    <span className="sp-button-label">View Project</span>
                  </a>
                  <ProjectModeration
                    showLoadingDialog
                    projectId={student.projectId}
                    client={client}
                    state={publicationState}
                    onChanged={onPublicationChanged}
                  />
                </fieldset>
              </div>
            </article>
          );
        })}
        {!rows.length && (
          <p role="status" className="admin-progress-empty">
            {students.length
              ? "No published projects match this view."
              : "No published student projects are available."}
          </p>
        )}
      </div>
      {selecting && (
        <SelectionBar
          className="admin-project-selection"

          label="Project selection"
        >
          <div className="sp-selection-summary">
            <span role="status">
              {picked.length ? `${picked.length} selected` : "Select projects"}
            </span>
            <button
              type="button"
              className="sp-select-all-action"
              disabled={!ids.length}
              onClick={() => setSelected(allSelected ? [] : ids)}
            >
              <span className="sp-plain-label">{allSelected ? "Clear all" : "Select all"}</span>
            </button>
          </div>
          <div className="admin-selection-actions">
            <ProjectModeration
              showLoadingDialog
              projectId={assignment.details.assignmentId}
              projectIds={picked}
              client={client}
              state={bulkError ? undefined : aggregate}
              selection
              showSelectionCount={false}
              onChanged={() => {}}
              onCompleted={refreshSelected}
            />
          </div>
        </SelectionBar>
      )}
    </section>
  );
}
