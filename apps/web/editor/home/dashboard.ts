import type { ReactNode } from "react";
import type { AssignmentProject } from "../projects/assignment-api";

export type DashboardView = "facilitator" | "creator-projects" | "creator-published";
export type RenderWorkspace = (content: ReactNode, dashboard?: DashboardView) => ReactNode;
export type WorkStatus = "Awaiting Approval" | "In Progress" | "Completed" | "Status unavailable";

export function assignmentProgress(projects: readonly AssignmentProject[]): {
  status: WorkStatus;
  submitted: number | null;
} {
  const states = projects.map((project) => project.reviewState);
  const known = states.every((state) => state != null);
  const status = states.includes("pending")
    ? "Awaiting Approval"
    : !known
      ? "Status unavailable"
      : states.length > 0 && states.every((state) => state === "approved")
        ? "Completed"
        : "In Progress";
  return { status, submitted: known ? states.filter((state) => state !== "draft").length : null };
}
