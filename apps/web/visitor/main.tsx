import { combineAbortSignals } from "../shared/network/abort-signals";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadPublication, type PublishedExhibition } from "./publication";
import { ExhibitionContent } from "./ExhibitionContent";
import { ExhibitionCanvas } from "./ExhibitionCanvas";
import "./visitor.css";

function Visitor() {
  const publicationId = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i)?.[1] ?? "";
  const [exhibition, setExhibition] = useState<PublishedExhibition | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [scene, setScene] = useState(0);
  const [viewpoint, setViewpoint] = useState<Readonly<{ id: string }>>();

  const [playbackReady, setPlaybackReady] = useState<Readonly<{
    exhibition: PublishedExhibition;
    scene: number;
    viewpoint: typeof viewpoint;
  }> | null>(null);

  const visitedScenes = useRef(new Set<string>());
  const [navigationLoop, setNavigationLoop] = useState(false);
  const currentSceneKey = exhibition?.document.scenes[scene]?.id.toLowerCase();

  function beginNavigationEvent() {
    setNavigationLoop(false);
    if (!currentSceneKey) return;
    if (visitedScenes.current.size === 1 && visitedScenes.current.has(currentSceneKey)) return;
    visitedScenes.current.clear();
    visitedScenes.current.add(currentSceneKey);
  }

  // Navigation changes only the visitor's current view; the published document stays unchanged
  function navigate(sceneId: string, viewpointId?: string, deliberate = false): boolean {
    const index =
      exhibition?.document.scenes.findIndex(
        (item) => item.id.toLowerCase() === sceneId.toLowerCase(),
      ) ?? -1;
    if (index < 0) return false;
    const key = sceneId.toLowerCase();
    if (deliberate) beginNavigationEvent();
    else if (visitedScenes.current.has(key)) {
      setNavigationLoop(true);
      return false;
    }
    visitedScenes.current.add(key);
    setScene(index);

    // A fresh request reapplies the saved camera even when the visitor chooses the same point again
    setViewpoint(viewpointId === undefined ? undefined : { id: viewpointId });
    return true;
  }
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

          // A reloaded publication starts fresh rather than keeping a scene index from the old response
          visitedScenes.current = new Set([value.document.scenes[0]!.id.toLowerCase()]);
          setNavigationLoop(false);
          setScene(0);
          setViewpoint(undefined);
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
      <main
        id="exhibition"
        className={exhibition && !error ? "visitor-preview is-walking" : "visitor-state"}
      >
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
            <h1 className="sr-only">{exhibition.document.title}</h1>
            <div className="visitor-scene-picker">
              <label>
                Scene
                <select
                  value={scene}
                  onChange={(event) => {
                    const target = exhibition.document.scenes[Number(event.target.value)];
                    if (target) navigate(target.id, undefined, true);
                  }}
                >
                  {exhibition.document.scenes.map((item, index) => (
                    <option key={item.id} value={index}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ExhibitionCanvas
              key={scene}
              exhibition={exhibition}
              sceneIndex={scene}
              viewpoint={viewpoint}
              navigate={navigate}
              beginNavigationEvent={beginNavigationEvent}
              onPlaybackReady={(ready) =>
                setPlaybackReady(ready ? { exhibition, scene, viewpoint } : null)
              }
            />
            {navigationLoop && (
              <p className="visitor-status" role="status">
                Automatic scene navigation stopped at a repeated scene.
              </p>
            )}
            <ExhibitionContent
              scene={exhibition.document.scenes[scene]!}
              assets={exhibition.assets}
              playbackReady={
                playbackReady?.exhibition === exhibition &&
                playbackReady.scene === scene &&
                playbackReady.viewpoint === viewpoint
              }
              navigate={(id, view) => navigate(id, view, true)}
            />
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
