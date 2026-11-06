import { useEffect, useState, type ReactNode } from "react";
import { createAccountClient } from "./account-client";

const accounts = createAccountClient();

/** Built editors use protected catalogue bytes, including the local-file editor at /. */
export function EditorSessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "signed-out" | "error">("checking");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void accounts.getSession().then(
      (session) => {
        if (!cancelled) setState(session && !session.mustChangePassword ? "ready" : "signed-out");
      },
      () => {
        if (!cancelled) setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  if (state === "ready") return children;
  return (
    <main className="project-loading">
      <h1>Open editor</h1>
      <p role="status">
        {state === "checking"
          ? "Checking your session…"
          : state === "signed-out"
            ? "Sign in to load your rooms and objects. Your browser recovery data is preserved."
            : "The account service could not be reached. Check your connection and retry."}
      </p>
      {state === "signed-out" && <a href="/login?returnTo=%2F">Sign in</a>}
      {state !== "checking" && (
        <button
          onClick={() => {
            setState("checking");
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </button>
      )}
    </main>
  );
}
