import { Icon as UiIcon } from "@iconify/react/offline";
import faCircleCheck from "@iconify-icons/lucide/circle-check";
import faClock from "@iconify-icons/lucide/clock";
import faGlobe from "@iconify-icons/lucide/globe";
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
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "progress" | "awaiting">("all");
  const students = assignment.details.projects;
  const inProgress = students.filter(
    (row) => row.approvalStatus !== "approved" && row.approvalStatus !== "awaiting-approval",
  );
  const awaiting = students.filter((row) => row.approvalStatus === "awaiting-approval");
  const rows = (filter === "all" ? students : filter === "awaiting" ? awaiting : inProgress).filter(
    (row) =>
      (row.studentName ?? "").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <section className="admin-progress" aria-label="Student progress">
      <div className="admin-progress-controls">
        <SearchField
          label="Search students"
          placeholder="Search students by name or account"
          value={search}
          onChange={setSearch}
        />
        <Tabs
          id="admin-student-status"
          label="Student project status"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: `All Work (${students.length})` },
            { value: "progress", label: `In Progress (${inProgress.length})` },
            {
              value: "awaiting",
              label: `Awaiting Approval (${awaiting.length})`,
            },
          ]}
        />
      </div>
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
                  href={`/?projectId=${encodeURIComponent(student.projectId)}`}
                >
                  <span className="sp-button-label">View Progress</span>
                </a>
                <ProjectModeration
                  projectId={student.projectId}
                  client={client}
                  state={publicationState}
                  onChanged={onPublicationChanged}
                />
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
