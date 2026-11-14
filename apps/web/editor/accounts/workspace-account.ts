import type { AccountSession, createAccountClient } from "./account-client";

type AccountClient = Pick<ReturnType<typeof createAccountClient>, "getSession" | "signOut">;
type State =
  | { kind: "checking" | "password-required"; workspace: AccountSession | null }
  | { kind: "ready" | "signing-out"; workspace: AccountSession }
  | { kind: "error"; workspace: AccountSession | null; message: string }
  | { kind: "signed-out"; workspace: null };

function sameAccount(a: AccountSession | null, b: AccountSession) {
  return a?.userId === b.userId && a.orgId === b.orgId && a.role === b.role;
}

// A retained workspace keeps its draft while access is checked. Only "ready" grants interaction.
export function createWorkspaceAccount(client: AccountClient) {
  let state: State = { kind: "checking", workspace: null };
  let generation = 0;
  const listeners = new Set<() => void>();
  function transition(next: State) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate() {
      generation++;
    },
    async check() {
      if (state.kind === "signing-out" || state.kind === "signed-out") return;
      const read = ++generation;
      const workspace = state.workspace;
      transition({ kind: "checking", workspace });
      try {
        const session = await client.getSession();
        if (read !== generation) return;
        if (!session) transition({ kind: "signed-out", workspace: null });
        else if (session.mustChangePassword)
          transition({
            kind: "password-required",
            workspace: sameAccount(workspace, session) ? workspace : null,
          });
        else {
          // Keep unchanged identity stable so revalidation does not reload workspace data
          const unchanged =
            sameAccount(workspace, session) &&
            workspace?.displayName === session.displayName &&
            workspace.orgName === session.orgName &&
            workspace.mustChangePassword === session.mustChangePassword &&
            workspace.developmentAssetsAllowed === session.developmentAssetsAllowed;
          transition({
            kind: "ready",
            workspace: unchanged ? workspace! : session,
          });
        }
      } catch {
        if (read === generation)
          transition({
            kind: "error",
            workspace,
            message: "Your session could not be verified. Retry before continuing.",
          });
      }
    },
    async signOut(expected: AccountSession) {
      if (state.kind !== "ready" || !sameAccount(state.workspace, expected)) return;
      const write = ++generation;
      const workspace = state.workspace;
      transition({ kind: "signing-out", workspace });
      try {
        await client.signOut(workspace.userId);
        if (write === generation) transition({ kind: "signed-out", workspace: null });
      } catch {
        if (write === generation)
          transition({
            kind: "error",
            workspace,
            message: "Sign-out could not be confirmed. Retry to check your session.",
          });
      }
    },
  };
}
