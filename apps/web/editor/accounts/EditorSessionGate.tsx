import { useEffect, useState, type ReactNode } from "react";
import { createAccountClient } from "./account-client";
import { LoginRedirect } from "./LoginRedirect";

const accounts = createAccountClient();

/** The packaged local-file editor uses protected catalogue bytes. */
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
  if (state === "signed-out") return <LoginRedirect />;
  return (
    <main className="project-loading">
      <h1>Open editor</h1>
      <p role="status">
        {state === "checking"
          ? "Checking your session…"
          : "The account service could not be reached. Check your connection and retry."}
      </p>
      {state === "error" && (
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
