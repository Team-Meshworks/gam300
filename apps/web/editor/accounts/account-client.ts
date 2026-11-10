export type AccountRole = "Administrator" | "Educator" | "Creator";
export interface AccountSession {
  userId: string;
  displayName: string;
  role: AccountRole;
  orgId: string | null;
  orgName?: string | null;
  mustChangePassword: boolean;
  developmentAssetsAllowed?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function createAccountClient(request: typeof fetch = fetch) {
  async function send(path: string, init: RequestInit = {}) {
    try {
      return await request(path, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(
        "The account service could not be reached. Check your connection and try again.",
      );
    }
  }
  async function readJson(response: Response): Promise<unknown> {
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error(
        response.status === 429
          ? "Too many attempts. Please wait before trying again."
          : "The account service is unavailable. Please try again later.",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error("The account service returned an invalid response.");
    }
  }
  async function csrf(accountId?: string) {
    const value = await readJson(
      await send(
        "/api/v1/auth/csrf",
        accountId ? { headers: { "X-Spatia-Account": accountId } } : {},
      ),
    );
    if (!isRecord(value) || typeof value.requestToken !== "string" || !value.requestToken)
      throw new Error("The account service is unavailable. Please reload and try again.");
    return value.requestToken;
  }
  async function getSession(): Promise<AccountSession | null> {
    const response = await send("/api/v1/auth/session");
    if (response.status === 401) return null;
    const value = await readJson(response);
    if (
      !isRecord(value) ||
      !isId(value.userId) ||
      typeof value.displayName !== "string" ||
      !value.displayName ||
      typeof value.mustChangePassword !== "boolean" ||
      !(value.orgName == null || typeof value.orgName === "string") ||
      !["Administrator", "Educator", "Creator"].includes(String(value.role)) ||
      (value.role === "Administrator" ? value.orgId !== null : !isId(value.orgId))
    ) {
      throw new Error("The account session could not be verified. Please sign in again.");
    }
    return {
      userId: value.userId,
      displayName: value.displayName,
      role: value.role as AccountRole,
      orgId: value.orgId as string | null,
      ...(typeof value.orgName === "string" ? { orgName: value.orgName } : {}),
      mustChangePassword: value.mustChangePassword,
      developmentAssetsAllowed: value.developmentAssetsAllowed === true,
    };
  }
  async function signIn(userName: string, password: string): Promise<AccountSession> {
    const token = await csrf();
    const response = await send("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
      body: JSON.stringify({ userName, password }),
    });
    if (response.status === 401) throw new Error("The username or password could not be accepted.");
    if (response.status === 403)
      throw new Error("Your account needs a password change before you can continue.");
    if (response.status !== 204) {
      throw new Error(
        response.status === 429
          ? "Too many attempts. Please wait before trying again."
          : "Sign-in could not be completed. Please try again later.",
      );
    }
    await csrf();
    const session = await getSession();
    if (!session) throw new Error("The sign-in session could not be confirmed. Please try again.");
    return session;
  }
  async function accountWrite(path: string, body?: object, accountId?: string) {
    const token = await csrf(accountId);
    const response = await send(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": token,
        ...(accountId ? { "X-Spatia-Account": accountId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== 204)
      throw new Error(
        response.status === 401
          ? "Your session has expired. Please sign in again."
          : response.status === 429
            ? "Too many attempts. Please wait before trying again."
            : "The account change could not be completed. Check your details and try again.",
      );
    await csrf();
  }
  async function changePassword(currentPassword: string, newPassword: string) {
    await accountWrite("/api/v1/auth/password", { currentPassword, newPassword });
    const session = await getSession();
    if (!session || session.mustChangePassword)
      throw new Error("The updated session could not be confirmed. Please sign in again.");
    return session;
  }
  async function signOut(accountId?: string) {
    await accountWrite("/api/v1/auth/logout", undefined, accountId);
    if (await getSession()) throw new Error("Sign-out could not be confirmed. Please try again.");
  }
  return { getSession, signIn, changePassword, signOut };
}
