import { useEffect, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { createReviewClient } from "./review-client";
import { educatorReviewLink } from "./educator-review-link";

const accounts = createAccountClient();
const reviews = createReviewClient();

export function EducatorReviewLink({ session }: { session: AccountSession }) {
  const [ids] = useState(() => new URLSearchParams(location.search).getAll("projectId"));
  const [error, setError] = useState(ids.length > 1 ? "The review link is invalid." : "");
  useEffect(() => {
    let disposed = false;
    if (!ids.length) {
      location.replace("/home");
      return;
    }
    if (ids.length !== 1) return;
    void educatorReviewLink(ids[0]!, session, reviews, accounts.getSession).then(
      (url) => {
        if (!disposed) location.replace(url);
      },
      (cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "The review could not be opened.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [ids, session]);
  return (
    <main className="sp-workspace">
      <h1>Open student review</h1>
      {error ? <p role="alert">{error}</p> : <p role="status">Checking the assigned project…</p>}
      <a href="/home">Home</a>
    </main>
  );
}
