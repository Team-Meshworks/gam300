import { useState } from "react";
import { Icon } from "@iconify/react/offline";
import arrow from "@iconify-icons/lucide/arrow-right";
import clock from "@iconify-icons/lucide/clock-3";
import check from "@iconify-icons/lucide/circle-check";
import alert from "@iconify-icons/lucide/circle-alert";
import link from "@iconify-icons/lucide/link";
import { Button } from "../../shared/ui/Button";
import { formatLocalDeadline } from "../projects/deadline";
import type { StudentPublication } from "./student-publication";
import type { StudentProjectRow } from "./student-projects";
import neutralCover from "./assets/default-project-neutral.jpg";

function dueLabel(seconds: number) {
  const due = new Date(seconds * 1000);
  const now = new Date();
  if (due < now) return "Past due";
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = (day(due) - day(now)) / 86400000;
  return days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`;
}

export function CreatorProjectCard({
  row,
  name,
  publication,
  onOpen,
  onDetails,
}: {
  row: StudentProjectRow;
  name: string;
} & (
  | { publication: StudentPublication; onOpen?: never; onDetails?: never }
  | { publication?: undefined; onOpen: () => void; onDetails: () => void }
)) {
  const { project, assignment } = row;
  const details = assignment?.details;
  const state = details?.projects.find((item) => item.projectId === project.projectId)?.reviewState;
  const due = details && formatLocalDeadline(details.dueAtUnixSeconds);
  const [copyMessage, setCopyMessage] = useState("");
  async function copy() {
    if (!publication) return;
    try {
      await navigator.clipboard.writeText(publication.visitorUrl);
      setCopyMessage("Link copied.");
    } catch {
      setCopyMessage("Select the link and copy it.");
      const field = document.getElementById(`share-${project.projectId}`);
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
    }
  }
  return (
    <article
      className={`sp-student-card${publication ? " sp-student-card--published" : ""}`}
      aria-labelledby={`title-${project.projectId}`}
    >
      <img className="sp-student-card-image" src={neutralCover} alt="" />
      <div className="sp-student-card-copy">
        <div className="sp-student-identity">
          <h2 id={`title-${project.projectId}`}>{project.title}</h2>
          <p>
            {publication
              ? assignment
                ? `Created by: ${name}`
                : `Published ${new Date(publication.createdAt).toLocaleDateString()}`
              : details?.assignedBy
                ? `Assigned by: ${details.assignedBy}`
                : assignment
                  ? assignment.className
                  : "No class assignment listed"}
          </p>
        </div>
        {details?.description && <p className="sp-card-description">{details.description}</p>}
        <div className="sp-card-actions">
          {publication ? (
            <a
              className="sp-button sp-preview"
              href={publication.visitorUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Preview
            </a>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={!project.permissions.canEdit || project.archived}
                onClick={onOpen}
              >
                {project.revision === 0 ? "Start editing" : "Continue editing"}
              </Button>
              <button
                type="button"
                id={`student-project-${project.projectId}`}
                onClick={onDetails}
                className="sp-view-details"
              >
                View details <Icon icon={arrow} width={15} />
              </button>
            </>
          )}
        </div>
      </div>
      {publication ? (
        <div className="sp-published-share">
          <h3>
            <Icon icon={link} width={20} />
            <label htmlFor={`share-${project.projectId}`}>Share your project</label>
          </h3>
          <input
            id={`share-${project.projectId}`}
            type="url"
            readOnly
            value={publication.visitorUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button variant="primary" onClick={() => void copy()}>
            Copy
          </Button>
          {publication.requiresSignIn && <small>Only permitted viewers can open this link.</small>}
          <span role="status">{copyMessage}</span>
        </div>
      ) : (
        <dl className="sp-student-metadata">
          <div>
            <dt>Deadline</dt>
            <dd className="sp-due">
              {details && due ? (
                <>
                  <Icon icon={clock} width={16} />
                  <time
                    dateTime={new Date(details.dueAtUnixSeconds * 1000).toISOString()}
                    title={due}
                  >
                    {dueLabel(details.dueAtUnixSeconds)}
                  </time>
                </>
              ) : (
                "No deadline listed"
              )}
            </dd>
          </div>
          <div>
            <dt>Approval status</dt>
            <dd>
              {state ? (
                <span className="sp-approval" data-state={state}>
                  <Icon
                    icon={state === "approved" ? check : state === "pending" ? clock : alert}
                    width={14}
                  />
                  {state === "approved"
                    ? "Approved"
                    : state === "pending"
                      ? "Awaiting Approval"
                      : "Not Approved"}
                </span>
              ) : assignment ? (
                "Status unavailable"
              ) : (
                "No review listed"
              )}
            </dd>
          </div>
        </dl>
      )}
    </article>
  );
}
