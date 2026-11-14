import type { ReactNode } from "react";
import { Button } from "../../shared/ui/Button";
import { Icon } from "@iconify/react/offline";
import lock from "@iconify-icons/lucide/lock-keyhole";
import clock from "@iconify-icons/lucide/clock-3";
import globe from "@iconify-icons/lucide/globe";
import check from "@iconify-icons/lucide/check";
import minus from "@iconify-icons/lucide/minus";
import close from "@iconify-icons/lucide/x";

export type PublishState = "incomplete" | "pending" | "approved" | "checking";
const copy = {
  checking: {
    subtitle: "Checking saved revision",
    title: "Publish Project",
    description: "Your saved project’s completion and approval status are being checked.",
    icon: clock,
  },
  incomplete: {
    subtitle: "Not completed",
    title: "Finish your work first",
    description:
      "Mark your work as completed, then send it to your teacher for approval. You can publish once it’s approved.",
    icon: lock,
  },
  pending: {
    subtitle: "Completed · Awaiting teacher approval",
    title: "Your teacher is reviewing your work",
    description:
      "Your completed work has been sent to your teacher. Publishing will be available once your teacher approves it.",
    icon: clock,
  },
  approved: {
    subtitle: "Completed · Teacher-approved",
    title: "Ready to publish your project?",
    description:
      "Your teacher has approved your completed work. Once published, anyone with the published link can view your project.",
    icon: globe,
  },
};

export function PublishStatus({
  state,
  titleId,
  onClose,
  closeLabel,
  locked = false,
  actions,
  children,
}: {
  state: PublishState;
  titleId: string;
  onClose: () => void;
  closeLabel: string;
  locked?: boolean;
  actions: ReactNode;
  children?: ReactNode;
}) {
  const current = copy[state];
  const completed = state !== "incomplete";
  const approved = state === "approved";
  return (
    <>
      <div className="publish-status-body">
        <header className="publish-status-header">
          <span className="publish-status-icon">
            <Icon icon={current.icon} width={20} aria-hidden="true" />
          </span>
          <div>
            <p className="publish-status-kicker">Publish Project</p>
            <p className="publish-status-subtitle">{current.subtitle}</p>
          </div>
          <Button
            className="sp-close-button creator-approval-close"
            aria-label={closeLabel}
            onClick={onClose}
            disabled={locked}
          >
            <Icon icon={close} width={18} />
          </Button>
        </header>
        <h2 id={titleId}>{current.title}</h2>
        <p className="publish-status-description">{current.description}</p>
        {state !== "checking" && (
          <>
            <div className="publish-status-requirements" aria-label="Publishing requirements">
              <div className="publish-status-row">
                <span className={`publish-status-marker${completed ? " is-complete" : ""}`}>
                  <Icon icon={completed ? check : minus} width={16} aria-hidden="true" />
                </span>
                <span className="publish-status-label">Work marked as completed</span>
                <span className={`publish-status-value${completed ? " is-complete" : ""}`}>
                  {completed ? "Completed" : "Not completed"}
                </span>
              </div>
              <div className="publish-status-row">
                <span className={`publish-status-marker${approved ? " is-complete" : ""}`}>
                  <Icon
                    icon={approved ? check : completed ? clock : minus}
                    width={16}
                    aria-hidden="true"
                  />
                </span>
                <span className="publish-status-label">Teacher approval</span>
                <span className={`publish-status-value${approved ? " is-complete" : ""}`}>
                  {approved ? "Approved" : completed ? "Awaiting approval" : "Not submitted"}
                </span>
              </div>
            </div>
            <p className={`publish-status-note${approved ? " is-complete" : ""}`}>
              <Icon icon={approved ? check : lock} width={14} aria-hidden="true" />
              <span>
                {approved
                  ? "Both requirements met. Your project is ready to publish."
                  : "Publishing is unavailable until both requirements are met."}
              </span>
            </p>
          </>
        )}
        {children}
      </div>
      <footer className="creator-approval-actions">{actions}</footer>
    </>
  );
}
