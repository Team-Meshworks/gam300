import type { AccountSession } from "../accounts/account-client";

export async function withPublicationSession<T>(
  expected: { userId: string; orgId: string | null },
  read: () => Promise<AccountSession | null>,
  send: () => Promise<T>,
): Promise<T | { kind: "unknown" }> {
  const matches = (session: AccountSession | null) =>
    session?.userId === expected.userId &&
    session.orgId === expected.orgId &&
    session.role === "Educator" &&
    !session.mustChangePassword;
  try {
    if (!matches(await read())) return { kind: "unknown" };
    const result = await send();
    return matches(await read()) ? result : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}
