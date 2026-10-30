import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Button } from "../../shared/ui/Button";
import { ProjectHome } from "./ProjectHome";
import "./home.css";

const accounts = createAccountClient();

export function HomePage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const signingOut = useRef(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      if (document.visibilityState === "hidden" || signingOut.current) return;
      const current = ++generation.current;
      setChecking(true);
      try {
        const value = await accounts.getSession();
        if (!alive || current !== generation.current) return;
        setSession(value);
        setError("");
      } catch {
        if (alive && current === generation.current)
          setError("Your session could not be verified. Retry before continuing.");
      } finally {
        if (alive && current === generation.current) setChecking(false);
      }
    }
    void check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [version]);
  async function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    generation.current++;
    setChecking(true);
    try {
      await accounts.signOut();
      setSession(null);
    } catch {
      setError("Sign-out could not be confirmed. Retry to check your session.");
    } finally {
      signingOut.current = false;
      setChecking(false);
    }
  }
  return (
    <>
      <a className="sp-skip-link" href="#workspace">
        Skip to workspace
      </a>
      {checking && (
        <p className="sp-home-gate" role="status">
          Checking your session…
        </p>
      )}
      {error && (
        <div className="sp-home-gate" role="alert">
          <p>{error}</p>
          <Button onClick={() => setVersion((value) => value + 1)}>Retry</Button>
          <a href="/login">Go to login</a>
        </div>
      )}
      {!checking && !error && (!session || session.mustChangePassword) && (
        <div className="sp-home-gate">
          <h1>{session ? "Change your password to continue" : "Log in to your workspace"}</h1>
          <a href="/login">Go to login</a>
        </div>
      )}
      {session && !session.mustChangePassword && (
        <div hidden={checking || !!error} inert={checking || !!error}>
          <WorkspaceShell
            key={`${session.userId}:${session.orgId}:${session.role}`}
            name={session.displayName}
            initials={session.displayName.slice(0, 2).toUpperCase()}
            onSignOut={() => void signOut()}
          >
            <ProjectHome session={session} />
          </WorkspaceShell>
        </div>
      )}
    </>
  );
}
