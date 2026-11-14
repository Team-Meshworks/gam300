import type { AccountSession } from "../accounts/account-client";
import { isId } from "../home/workspace-api";
import { progressEditorUrl } from "../projects/progress-navigation";
import { allPages, type ReviewClient } from "./review-client";

export async function educatorReviewLink(
  projectId: string,
  session: AccountSession,
  client: ReviewClient,
  getSession: () => Promise<AccountSession | null>,
): Promise<string> {
  const verify = async () => {
    const current = await getSession();
    if (
      !current ||
      current.userId !== session.userId ||
      current.orgId !== session.orgId ||
      current.role !== "Educator" ||
      current.mustChangePassword
    )
      throw new Error("Your account changed. Sign in again before reviewing.");
  };
  if (!isId(projectId) || session.role !== "Educator" || session.mustChangePassword)
    throw new Error("The review link is invalid.");
  await verify();
  const target = await client.projectAssignment(projectId);
  const classes = await allPages((cursor) => client.classrooms(cursor));
  if (!classes.some((row) => row.id === target.classId))
    throw new Error("The linked class is unavailable to your account.");
  const assignments = await allPages((cursor) => client.assignments(target.classId, cursor));
  const project = assignments
    .find((row) => row.assignmentId === target.assignmentId)
    ?.projects.find((row) => row.projectId === target.projectId);
  if (!project) throw new Error("This project is no longer available in the selected assignment.");
  await verify();
  return progressEditorUrl({ ...target, studentId: project.studentId });
}
