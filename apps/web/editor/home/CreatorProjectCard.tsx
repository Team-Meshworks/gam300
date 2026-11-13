import { useLayoutEffect, useRef, useState } from "react";
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
  const description = useRef<HTMLParagraphElement>(null);
  const [summary, setSummary] = useState<string | null>(null);
  useLayoutEffect(() => {
    const node = description.current;
    const text = details?.description;
    if (!node || publication || !text) return;
    // Measure the inline action too so it never covers a word or spills past the two-line summary
    const measure = () => {
      const probe = node.cloneNode(false) as HTMLParagraphElement;
      const style = getComputedStyle(node);
      Object.assign(probe.style, {
        position: "fixed",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${node.getBoundingClientRect().width}px`,
        display: "block",
        height: "auto",
        maxHeight: "none",
        overflow: "visible",
        WebkitLineClamp: "unset",
      });
      node.parentElement!.append(probe);
      const limit = parseFloat(style.lineHeight) * 2 + 1;
      probe.textContent = text;
      if (probe.getBoundingClientRect().height <= limit) {
        setSummary(null);
      } else {
        const words = text.trim().split(/\s+/u);
        const action = document.createElement("button");
        action.className = "sp-description-more";
        action.textContent = "Read more";
        const label = document.createElement("span");
        label.className = "sp-description-more-label";
        label.textContent = "Read more";
        action.replaceChildren(label);
        let low = 0;
        let high = words.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          probe.replaceChildren(`${words.slice(0, middle).join(" ")}… `, action);
          if (probe.getBoundingClientRect().height <= limit) low = middle;
          else high = middle - 1;
        }
        setSummary(words.slice(0, low).join(" "));
      }
      probe.remove();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [details?.description, publication]);
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
          <div className="sp-card-description-preview">
            <p ref={description} className="sp-card-description">
              {publication
                ? details.description.split(/(?<=[.!?])\s+/u, 1)[0]
                : summary === null
                  ? details.description
                  : `${summary}… `}
              {!publication && summary !== null && (
                <button
                  type="button"
                  className="sp-description-more"
                  aria-label={`Read more about ${project.title}`}
                  onClick={onDetails}
                >
                  <span className="sp-description-more-label">Read more</span>
                </button>
              )}
            </p>
          </div>
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
              onClick={() => setQrOpen(true)}
            >
              <Icon icon={qrCode} width={24} aria-hidden="true" />
            </button>
          </div>
          {qrOpen && (
            <dialog
              ref={qrDialog}
              className="sp-dialog sp-creator-qr-dialog"
              aria-label="QR code"
              onCancel={(event) => {
                event.preventDefault();
                setQrOpen(false);
              }}
              onClick={(event) => {
                if (event.target !== event.currentTarget) return;
                // Backdrop clicks target the dialog too; keep clicks inside its padding harmless
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                  event.clientX < bounds.left ||
                  event.clientX > bounds.right ||
                  event.clientY < bounds.top ||
                  event.clientY > bounds.bottom
                )
                  setQrOpen(false);
              }}
            >
              <div className="sp-dialog-body">
                <QRCodeSVG
                  value={publication.visitorUrl}
                  size={208}
                  marginSize={4}
                  level="M"
                  role="img"
                  aria-label={`QR code for ${project.title}`}
                />
              </div>
            </dialog>
          )}
          <div className="sp-published-copy">
            <Button variant="primary" onClick={() => void copy()}>
              Copy
            </Button>
            <span role="status">{copyMessage}</span>
          </div>
          {publication.requiresSignIn && <small>Only permitted viewers can open this link.</small>}
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
              <CreatorApproval row={row} />
            </dd>
          </div>
        </dl>
      )}
    </article>
  );
}
