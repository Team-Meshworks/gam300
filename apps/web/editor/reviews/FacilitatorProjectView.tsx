import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import { createClassroomClient } from "../home/classroom-api";
import type { AccountSession } from "../accounts/account-client";
import { createAccountClient } from "../accounts/account-client";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import {
  readServerAssets,
  readServerProject,
  type OpenedServerProject,
} from "../persistence/server-project-read";
import { readAssignment } from "../projects/assignment-api";
import {
  parseProgressContext,
  reviewReturnUrl,
  type ProgressContext,
} from "../projects/progress-navigation";
import { createDocumentStore } from "../document-store";
import { App, type ServerEditorSession } from "../App";
import { allPages, createReviewClient } from "./review-client";
import { Button } from "../../shared/ui/Button";
import { ProgressReviews } from "./ProgressReviews";
import "./reviews.css";
import "./facilitator-project.css";

const accounts = createAccountClient();
const reviews = createReviewClient();

export function FacilitatorProjectView({
  session,
  context,
}: {
  session: AccountSession;
  context: ProgressContext;
}) {
  const [loaded, setLoaded] = useState<{
    opened: OpenedServerProject;
    assets: readonly CatalogueAsset[];
    name: string;
    title: string;
    className: string;
    submissionStatus: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const className = createClassroomClient()
        .classes(controller.signal)
        .then((classes) => classes.find((row) => row.id === context.classId)?.name ?? "")
        .catch(() => "");
      const assignment = await readAssignment(
        context.classId,
        context.assignmentId,
        controller.signal,
      );
      const student = assignment.projects.find(
        (row) => row.projectId === context.projectId && row.studentId === context.studentId,
      );
      if (!student) throw new Error("This student project is unavailable in the selected class.");
      const assets = await readServerAssets(
        session.userId,
        controller.signal,
        fetch,
        context.projectId,
      );
      const opened = await readServerProject(
        context.projectId,
        session.userId,
