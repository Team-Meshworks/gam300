import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadPublication, type PublishedExhibition } from "./publication";
import { ExhibitionCanvas } from "./ExhibitionCanvas";
import "./visitor.css";

function Visitor() {
  const publicationId = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i)?.[1] ?? "";
  const [exhibition, setExhibition] = useState<PublishedExhibition | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [scene, setScene] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    void loadPublication(publicationId, signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setExhibition(value);
          document.title = `${value.document.title} · Spatia`;
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "The exhibition is unavailable.");
      });
    const recheck = () => {
      if (document.hidden) return;
      void fetch(`/api/v1/publications/${publicationId}/manifest`, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
      })
        .then((response) => {
          if (!response.ok && !controller.signal.aborted) {
            setExhibition(null);
            setError("This exhibition is unavailable or your account does not have access.");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setExhibition(null);
            setError("Access could not be checked. Reconnect and retry.");
          }
        });
    };
    window.addEventListener("focus", recheck);
    const timer = window.setInterval(recheck, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [publicationId, attempt]);
  return (
    <>
      <a className="skip" href="#exhibition">
        Skip to exhibition
      </a>
      <header>
        <a href="/landing">Spatia</a>
        <a href="/home">My projects</a>
      </header>
      <main id="exhibition">
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
          <>
            <h1>{exhibition.document.title}</h1>
            <p>Published edition · Saved revision {exhibition.sourceRevision}</p>
            <label>
              Scene
              <select value={scene} onChange={(event) => setScene(Number(event.target.value))}>
                {exhibition.document.scenes.map((item, index) => (
                  <option key={item.id} value={index}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <ExhibitionCanvas key={scene} exhibition={exhibition} sceneIndex={scene} />
          </>
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
