import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../../shared/ui/Button";
import { ModalActivity } from "../../shared/ui/useModal";
import { createAccountClient, type AccountSession } from "./account-client";
import { LoginRedirect } from "./LoginRedirect";
import { createWorkspaceAccount } from "./workspace-account";
import "./workspace-account.css";

export type WorkspaceAccess = {
  session: AccountSession;
  active: boolean;
  onSignOut: () => void;
};

export function WorkspaceAccountGate({
  children,
}: {
  children: (access: WorkspaceAccess) => ReactNode;
}) {
  const [account] = useState(() => createWorkspaceAccount(createAccountClient()));
  const state = useSyncExternalStore(account.subscribe, account.getSnapshot);
  useEffect(() => {
    function check() {
      if (document.visibilityState !== "hidden") void account.check();
    }
    function restored(event: PageTransitionEvent) {
      if (event.persisted) check();
    }
    check();
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", check);
    return () => {
      account.invalidate();
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", restored);
      document.removeEventListener("visibilitychange", check);
    };
  }, [account]);
  const session = state.workspace;
  const active = state.kind === "ready";
  return (
    <>
      {active && (
        <a className="sp-skip-link" href="#workspace">
          Skip to workspace
        </a>
      )}
      {!active && (
        <main className="sp-account-gate">
          {state.kind === "checking" && <p role="status">Checking your session…</p>}
          {state.kind === "signing-out" && <p role="status">Signing out…</p>}
          {state.kind === "signed-out" && <LoginRedirect />}
          {state.kind === "password-required" && (
            <>
              <h1>Change your password to continue</h1>
              <a href="/login">Go to login</a>
            </>
          )}
          {state.kind === "error" && (
            <>
              <p role="alert">{state.message}</p>
              <Button onClick={() => void account.check()}>Retry</Button>
              <a href="/login">Go to login</a>
            </>
          )}
        </main>
      )}
      {session && (
        <div hidden={!active} inert={!active}>
          <ModalActivity key={`${session.userId}:${session.orgId}:${session.role}`} value={active}>
            {children({ session, active, onSignOut: () => void account.signOut(session) })}
          </ModalActivity>
        </div>
      )}
    </>
  );
}
