import { useState, useCallback, useRef, type ReactNode } from "react";
import { ExhibitionCanvas } from "./ExhibitionCanvas";
import { ExhibitionContent } from "./ExhibitionContent";
import type { PlayerSnapshot } from "./player-snapshot";
import "./player.css";

export function ExhibitionPlayer({
  exhibition,
  controls,
}: {
  exhibition: PlayerSnapshot;
  controls?: ReactNode;
}) {
  const [scene, setScene] = useState(0);
  const [viewpoint, setViewpoint] = useState<Readonly<{ id: string }>>();

  const [notice, setNotice] = useState("");
  const visited = useRef(new Set([exhibition.document.scenes[0]!.id.toLowerCase()]));
  const beginInput = useCallback(() => {
    visited.current = new Set([exhibition.document.scenes[scene]!.id.toLowerCase()]);
    setNotice("");
  }, [exhibition, scene]);
  const navigate = useCallback(
    (sceneId: string, viewpointId: string) => {
      const id = sceneId.toLowerCase();
      const index = exhibition.document.scenes.findIndex((item) => item.id.toLowerCase() === id);
      if (index < 0) return false;
      if (visited.current.has(id)) {
        setNotice("Navigation stopped: scene-start interactions form a loop.");
        return false;
      }
      visited.current.add(id);
      setScene(index);
      setViewpoint(viewpointId ? { id: viewpointId } : undefined);
      return true;
    },
    [exhibition],
  );
  return (
    <section aria-label="Exhibition" className="visitor-preview is-walking">
      <h1 className="sr-only">{exhibition.document.title}</h1>
      <div className="visitor-scene-picker">
        <label>
          Scene
          <select
            value={scene}
            onChange={(event) => {
              const index = Number(event.target.value);
              visited.current = new Set([exhibition.document.scenes[index]!.id.toLowerCase()]);
              setNotice("");
              setScene(index);
              setViewpoint(undefined);
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
      {controls && <div className="preview-session-controls">{controls}</div>}
      {notice && (
        <p role="status" className="visitor-status">
          {notice}
        </p>
      )}
      <ExhibitionCanvas
        key={scene}
        exhibition={exhibition}
        beginInput={beginInput}
        sceneIndex={scene}
        viewpoint={viewpoint}
        navigate={navigate}
      />
      <ExhibitionContent
        scene={exhibition.document.scenes[scene]!}
        assets={exhibition.assets}
        navigate={(id, target) => {
          beginInput();
          if (id.toLowerCase() === exhibition.document.scenes[scene]!.id.toLowerCase()) {
            setViewpoint({ id: target });
          } else navigate(id, target);
        }}
      />
    </section>
  );
}
