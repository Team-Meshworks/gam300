import type { ReactNode } from "react";
import type { AssignmentProject } from "../projects/assignment-api";
import neutralCover from "./assets/default-project-neutral.jpg";
import silkRoadCard from "./assets/silk-road-card.jpg";
import silkRoadCover from "./assets/silk-road-cover.jpg";
import ancientRomeCover from "./assets/ancient-rome-cover.jpg";

// Keep the supplied example artwork with its matching project rather than unrelated student work
export function projectCover(title: string, detail = false) {
  if (title === "The Silk Road: A Journey Through History")
    return detail ? silkRoadCover : silkRoadCard;
  if (title === "Life in Ancient Rome") return ancientRomeCover;
  return neutralCover;
}

export type DashboardView =
  | "facilitator"
  | "facilitator-details"
  | "creator-projects"
  | "creator-published"
  | "creator-details";
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
  return {
    status,
    submitted: known ? states.filter((state) => state !== "draft").length : null,
  };
}

export function dueLabel(seconds: number) {
  const due = new Date(seconds * 1000);
  const now = new Date();
  if (due < now) return "Past Due";
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = (day(due) - day(now)) / 86400000;
  return days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`;
}
