import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ExhibitionCanvas } from "./ExhibitionCanvas";
import { ExhibitionContent } from "./ExhibitionContent";
import type { PlayerSnapshot } from "./player-snapshot";
import { createPlayerGraphics } from "./player-graphics";
import "./player.css";

export function ExhibitionPlayer({
  exhibition,
  previewControls,
}: {
  exhibition: PlayerSnapshot;
  previewControls?: ReactNode;
}) {
  const [scene, setScene] = useState(0);
  const graphics = useMemo(createPlayerGraphics, [exhibition]);
  useEffect(() => () => graphics.dispose(), [graphics]);
  const [viewpoint, setViewpoint] = useState<Readonly<{ id: string }>>();

  const [readyScene, setReadyScene] = useState<number | null>(null);
  const [visit, setVisit] = useState(0);
  const onPlaybackReady = useCallback(
    (ready: boolean) => setReadyScene(ready ? scene : null),
    [scene],
  );
  const [notice, setNotice] = useState("");
  const visited = useRef(new Set([exhibition.document.scenes[0]!.id.toLowerCase()]));
  const beginInput = useCallback(() => {
    visited.current = new Set([exhibition.document.scenes[scene]!.id.toLowerCase()]);
    setNotice("");
  }, [exhibition, scene]);
  const navigate = useCallback(
    (sceneId: string, viewpointId: string, deliberate: boolean) => {
      const id = sceneId.toLowerCase();
      const index = exhibition.document.scenes.findIndex((item) => item.id.toLowerCase() === id);
      if (index < 0) return false;
      if (!deliberate && visited.current.has(id)) {
        setNotice("Automatic scene navigation stopped at a repeated scene.");
        return false;
      }
      visited.current.add(id);
      setReadyScene(null);
      setVisit((previous) => previous + 1);
      setScene(index);
      setViewpoint(viewpointId ? { id: viewpointId } : undefined);
      return true;
    },
    [exhibition],
  );
  return (
    <section aria-label="Exhibition" className="visitor-preview is-walking">
      <h1 className="sr-only">{exhibition.document.title}</h1>
      {previewControls && <div className="preview-session-controls">{previewControls}</div>}
      {notice && (
        <p role="status" className="visitor-status">
          {notice}
        </p>
      )}
      <ExhibitionCanvas
        key={`${scene}-${visit}`}
        graphics={graphics}
        exhibition={exhibition}
        beginNavigationEvent={beginInput}
        onPlaybackReady={onPlaybackReady}
        sceneIndex={scene}
        viewpoint={viewpoint}
        navigate={navigate}
      />
      <ExhibitionContent
        visit={visit}
        scene={exhibition.document.scenes[scene]!}
        assets={exhibition.assets}
        playbackReady={readyScene === scene}
        navigate={(id, target) => {
          beginInput();
          if (id.toLowerCase() === exhibition.document.scenes[scene]!.id.toLowerCase()) {
            setViewpoint({ id: target });
          } else navigate(id, target, true);
        }}
      />
    </section>
  );
}
