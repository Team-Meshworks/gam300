import { createWorkspaceClient, isId } from "./workspace-api";
import { isRecord } from "../../shared/project/validation-helpers";

export interface Classroom {
  id: string;
  name: string;
  organizationId: string;
}
export interface ClassMember {
  userId: string;
  userName: string;
  role: "Educator" | "Creator";
  accountActive: boolean;
}
export interface EligibleStudent {
  userId: string;
  userName: string;
  enrolled: boolean;
}

export function classroom(value: unknown): Classroom {
  if (
    !isRecord(value) ||
    !("id" in value) ||
    !("organizationId" in value) ||
    !("name" in value) ||
    !isId(value.id) ||
    !isId(value.organizationId) ||
    typeof value.name !== "string"
  )
    throw new Error("Class information could not be verified.");
  return { id: value.id, organizationId: value.organizationId, name: value.name };
}

export function createClassroomClient(request: typeof fetch = fetch) {
  const api = createWorkspaceClient(request);
  async function classes(signal?: AbortSignal): Promise<Classroom[]> {
    const rows = (await api.pages("/api/v1/classes", signal)).map(classroom);
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("The class list is inconsistent.");
    return rows;
  }
  async function roster(
    classId: string,
    signal?: AbortSignal,
  ): Promise<{ members: ClassMember[]; eligible: EligibleStudent[] }> {
    const path = `/api/v1/classes/${encodeURIComponent(classId)}`;
    const [members, eligible] = await Promise.all([
      api.pages(`${path}/roster`, signal),
      api.pages(`${path}/eligible-students`, signal),
    ]);
    const roles = new Map<string, ClassMember["role"]>([
      ["d14c51b6-510a-4430-a27c-bfdc6e9d801b", "Educator"],
      ["862d776c-4d56-4dd8-919d-26044b6d8a44", "Creator"],
    ]);
    const parsedMembers = members.map((row) => {
      const role =
        isRecord(row) && "roleId" in row && typeof row.roleId === "string"
          ? roles.get(row.roleId)
          : undefined;
      if (
        !isRecord(row) ||
        !("userId" in row) ||
        !("userName" in row) ||
        !("accountActive" in row) ||
        !isId(row.userId) ||
        typeof row.userName !== "string" ||
        typeof row.accountActive !== "boolean" ||
        !role
      )
        throw new Error("The roster could not be verified.");
      return {
        userId: row.userId,
        userName: row.userName,
        accountActive: row.accountActive,
        role,
      };
    });
    const parsedEligible = eligible.map((row) => {
      if (
        !isRecord(row) ||
        !("userId" in row) ||
        !("userName" in row) ||
        !("enrolled" in row) ||
        !isId(row.userId) ||
        typeof row.userName !== "string" ||
        typeof row.enrolled !== "boolean"
      )
        throw new Error("The roster could not be verified.");
      return { userId: row.userId, userName: row.userName, enrolled: row.enrolled };
    });
    if (
      new Set(parsedMembers.map((row) => row.userId)).size !== parsedMembers.length ||
      new Set(parsedEligible.map((row) => row.userId)).size !== parsedEligible.length
    )
      throw new Error("The roster could not be verified.");
    return { members: parsedMembers, eligible: parsedEligible };
  }
  return { classes, roster };
}
