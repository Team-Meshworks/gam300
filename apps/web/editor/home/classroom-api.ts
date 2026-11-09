import { createWorkspaceClient, isId, isRecord } from "./workspace-api";

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
    !isId(value.id) ||
    !isId(value.organizationId) ||
    typeof value.name !== "string"
  )
    throw new Error("Class information could not be verified.");
  return value as unknown as Classroom;
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
    const roles: Record<string, ClassMember["role"]> = {
      "d14c51b6-510a-4430-a27c-bfdc6e9d801b": "Educator",
      "862d776c-4d56-4dd8-919d-26044b6d8a44": "Creator",
    };
    const parsedMembers = members.map((row) => {
      if (
        !isRecord(row) ||
        !isId(row.userId) ||
        typeof row.userName !== "string" ||
        typeof row.accountActive !== "boolean" ||
        typeof row.roleId !== "string" ||
        !roles[row.roleId]
      )
        throw new Error("The roster could not be verified.");
      return {
        userId: row.userId,
        userName: row.userName,
        accountActive: row.accountActive,
        role: roles[row.roleId]!,
      };
    });
    if (
      eligible.some(
        (row) =>
          !isRecord(row) ||
          !isId(row.userId) ||
          typeof row.userName !== "string" ||
          typeof row.enrolled !== "boolean",
      ) ||
      new Set(parsedMembers.map((row) => row.userId)).size !== parsedMembers.length ||
      new Set(eligible.map((row) => (row as EligibleStudent).userId)).size !== eligible.length
    )
      throw new Error("The roster could not be verified.");
    return { members: parsedMembers, eligible: eligible as EligibleStudent[] };
  }
  return { classes, roster };
}
