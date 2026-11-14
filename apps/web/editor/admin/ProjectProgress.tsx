import { Icon as UiIcon } from "@iconify/react/offline";
import faCircleCheck from "@iconify-icons/lucide/circle-check";
import faClock from "@iconify-icons/lucide/clock";
import faGlobe from "@iconify-icons/lucide/globe";
import selectIcon from "@iconify-icons/lucide/square-check";
import { Button } from "../../shared/ui/Button";
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

const approvalLabels = {
  "not-submitted": "Not Submitted",
  "awaiting-approval": "Awaiting Approval",
  approved: "Approved",
  returned: "Changes Requested",
  revoked: "Approval Revoked",
  "changes-since-submission": "Changes Since Submission",
};

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
  const [filter, setFilter] = useState<"all" | "progress" | "awaiting">("all");
  const students = assignment.details.projects.filter((student) => {
    const state = publicationStates[student.projectId.toLowerCase()];
    return state ? state.publicationCount > 0 : student.published === true;
  });
  const inProgress = students.filter(
    (row) => row.approvalStatus !== "approved" && row.approvalStatus !== "awaiting-approval",
  );
  const awaiting = students.filter((row) => row.approvalStatus === "awaiting-approval");
  const rows = (filter === "all" ? students : filter === "awaiting" ? awaiting : inProgress).filter(
    (row) =>
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
  async function refreshSelected() {
    setBulkError("");
    try {
      const states = await client.publicationStates(
        assignment.details.projects.map((row) => row.projectId),
      );
      for (const state of Object.values(states)) onPublicationChanged(state);
      setSelected([]);
    } catch {
      setBulkError(
        "Publication visibility could not be refreshed. Reload before making another change.",
      );
    }
  }
  return (
    <section className="admin-progress" aria-label="Student progress">
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
          {selecting ? (
            <div className="admin-project-selection" role="group" aria-label="Project selection">
              <label>
                <input
                  className="sp-selection-checkbox"
                  type="checkbox"
                  aria-label="Select all visible projects"
                  checked={allSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = picked.length > 0 && !allSelected;
                  }}
                  onChange={() => setSelected(allSelected ? [] : ids)}
                />
                Select all
              </label>
              <div className="admin-selection-actions">
                <Button
                  onClick={() => {
                    setSelecting(false);
                    setSelected([]);
                  }}
                >
                  Cancel
                </Button>
                <ProjectModeration
                  projectId={assignment.details.assignmentId}
                  projectIds={picked}
                  client={client}
                  state={bulkError ? undefined : aggregate}
                  selection
                  onChanged={() => {}}
                  onCompleted={refreshSelected}
                />
              </div>
            </div>
          ) : (
            <>
              <Tabs
                id="admin-student-status"
                label="Student project status"
                value={filter}
                onChange={(value) => {
                  setFilter(value);
                  setSelected([]);
                }}
                items={[
                  { value: "all", label: `All Work (${students.length})` },
                  { value: "progress", label: `In Progress (${inProgress.length})` },
                  {
                    value: "awaiting",
                    label: `Awaiting Approval (${awaiting.length})`,
                  },
                ]}
              />
              <Button
                className="admin-select-projects"
                aria-label="Select projects"
                title="Select projects"
                disabled={!ids.length}
                onClick={() => setSelecting(true)}
              >
                <UiIcon icon={selectIcon} aria-hidden="true" />
              </Button>
            </>
          )}
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
            <article className="admin-progress-row" key={student.projectId}>
              <div className="admin-student-identity">
                {selecting && (
                  <input
                    className="sp-selection-checkbox"
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
                <span className="admin-student-avatar" aria-hidden="true">
                  {initials}
                </span>
                <div>
                  <strong>{name}</strong>
                  {account && <span>@{account}</span>}
                </div>
              </div>
              <dl className="admin-student-status">
                <dt>Approval Status</dt>
                <dd
                  className={
                    student.approvalStatus === "approved" ? "admin-status-approved" : undefined
                  }
                >
                  <UiIcon
                    icon={student.approvalStatus === "approved" ? faCircleCheck : faClock}
                    aria-hidden="true"
                  />
                  {student.approvalStatus ? approvalLabels[student.approvalStatus] : "Unavailable"}
                </dd>
                <dt>Publish Status</dt>
                <dd
                  className={
                    (isPublic ?? student.published)
                      ? "admin-status-approved"
                      : "admin-status-private"
                  }
                >
                  <UiIcon
                    icon={(isPublic ?? student.published) ? faGlobe : faLock}
                    aria-hidden="true"
                  />
                  {isPublic !== undefined
                    ? isPublic
                      ? "Public"
                      : "Private"
                    : student.published === undefined
                      ? "Unavailable"
                      : student.published
                        ? "Published"
                        : "Not Published"}
                </dd>
              </dl>
              <div
                className="admin-student-actions"
                aria-label={`Publication controls for ${name}`}
              >
                <a
                  className="sp-button sp-button--primary"
                  href={`/?${new URLSearchParams({
                    projectId: student.projectId,
                    view: "published",
                    returnProjectId: new URLSearchParams(location.search).get("projectId") ?? "",
                    returnView: new URLSearchParams(location.search).get("view") ?? "",
                  })}`}
                >
                  <span className="sp-button-label">View Project</span>
                </a>
                {!selecting && (
                  <ProjectModeration
                    projectId={student.projectId}
                    client={client}
                    state={publicationState}
                    onChanged={onPublicationChanged}
                  />
                )}
              </div>
            </article>
          );
        })}
        {!rows.length && (
          <p role="status" className="admin-progress-empty">
            {students.length
              ? "No student projects match this view."
              : "No students are assigned to this project."}
          </p>
        )}
      </div>
    </section>
  );
}
