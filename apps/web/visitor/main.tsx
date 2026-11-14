import { combineAbortSignals } from "../shared/network/abort-signals";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadPublication, type PublishedExhibition } from "./publication";
import { ExhibitionPlayer } from "../shared/player/ExhibitionPlayer";
import "./visitor.css";

function Visitor() {
  const publicationId = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i)?.[1] ?? "";
  const [exhibition, setExhibition] = useState<PublishedExhibition | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const initialTitle = document.title;
    const signal = combineAbortSignals([controller.signal, AbortSignal.timeout(20000)]);
    function unavailable(message: string) {
      if (controller.signal.aborted) return;
      controller.abort();
      document.title = initialTitle;
      setExhibition(null);
      setError(message);
    }
    void loadPublication(publicationId, signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setExhibition(value);

          document.title = `${value.document.title} · Spatia`;
        }
      })
      .catch((failure: unknown) => {
        unavailable(failure instanceof Error ? failure.message : "The exhibition is unavailable.");
      });
    let latestAccessCheck = 0;
    let latestAccessDecision = 0;
    const recheck = () => {
      if (document.hidden || controller.signal.aborted) return;
      const check = ++latestAccessCheck;
      void fetch(`/api/v1/publications/${publicationId}/manifest`, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
      })
        .then((response) => {
          if (check < latestAccessDecision) return;
          latestAccessDecision = check;
          if (!response.ok)
            unavailable("This exhibition is unavailable or your account does not have access.");
        })
        .catch(() => {
          if (check >= latestAccessDecision)
            unavailable("Access could not be checked. Reconnect and retry.");
        });
    };
    window.addEventListener("focus", recheck);
    const timer = window.setInterval(recheck, 30000);
    return () => {
      controller.abort();
      document.title = initialTitle;
      clearInterval(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [publicationId, attempt]);
  return (
    <>
      <a className="skip" href="#exhibition">
        Skip to exhibition
      </a>
      <main id="exhibition" className={exhibition && !error ? undefined : "visitor-state"}>
        {error ? (
          <>
            <h1>Exhibition unavailable</h1>
            <p role="alert">{error}</p>
            <a href={`/login?returnTo=${encodeURIComponent(`/p/${publicationId}`)}`}>
              Sign in to view exhibition
            </a>
            <button
              onClick={() => {
                setError("");
                setExhibition(null);
                setAttempt((value) => value + 1);
              }}
            >
              Retry
            </button>
          </>
        ) : exhibition ? (
          <ExhibitionPlayer exhibition={exhibition} />
        ) : (
          <p role="status">Opening exhibition…</p>
        )}
      </main>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Visitor root is missing");
createRoot(root).render(<Visitor />);
