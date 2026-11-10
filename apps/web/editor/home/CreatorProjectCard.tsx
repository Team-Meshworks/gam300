import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import qrCode from "@iconify-icons/lucide/qr-code";
import { useModal } from "../../shared/ui/useModal";
import { dueLabel, projectCover } from "./dashboard";
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
// Share the same current approval state between the card and its details
export function CreatorApproval({
  row,
  submittedState,
}: {
  row: StudentProjectRow;
  submittedState?: "pending" | "approved" | null;
}) {
  const { project, assignment } = row;
  const state =
    submittedState ??
    assignment?.details.projects.find((item) => item.projectId === project.projectId)?.reviewState;
  if (!state) return assignment ? "Status unavailable" : "No review listed";
  return (
    <span className="sp-approval" data-state={state}>
      <Icon icon={state === "approved" ? check : state === "pending" ? clock : alert} width={14} />
      {state === "approved"
        ? "Approved"
        : state === "pending"
          ? "Awaiting Approval"
          : "Not Approved"}
    </span>
  );
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
  const due = details && formatLocalDeadline(details.dueAtUnixSeconds);
  const [copyMessage, setCopyMessage] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const qrDialog = useModal(qrOpen);
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
      <img
        className="sp-student-card-image"
        src={project.image?.url ?? projectCover(project.title)}
        alt=""
      />
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
        {details?.description && (
          <p className="sp-card-description">
            {/* Keep the published summary brief; the project details retain the complete description */}
            {publication ? details.description.split(/(?<=[.!?])\s+/u, 1)[0] : details.description}
          </p>
        )}
        <div className="sp-card-actions">
          {publication ? (
            <a className="sp-button sp-preview" href={publication.visitorUrl}>
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
          <div className="sp-published-link-row">
            <input
              id={`share-${project.projectId}`}
              type="url"
              readOnly
              value={publication.visitorUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="sp-published-qr"
              aria-label={`Show QR code for ${project.title}`}
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
