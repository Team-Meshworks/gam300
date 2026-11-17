import { useEffect, useState } from "react";
import type { PlayerSnapshot } from "../shared/player/player-snapshot";

type Player = typeof import("../shared/player/ExhibitionPlayer").ExhibitionPlayer;

export function StudentPreview({ snapshot, onExit }: { snapshot: PlayerSnapshot; onExit(): void }) {
  const [Player, setPlayer] = useState<Player | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [visit, setVisit] = useState(0);
  useEffect(() => {
    let active = true;
    void import("../shared/player/ExhibitionPlayer").then(
      ({ ExhibitionPlayer }) => {
        if (active) setPlayer(() => ExhibitionPlayer);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const exit = <button onClick={onExit}>Exit preview</button>;
  if (!Player)
    return (
      <main>
        <p role="status">{failed ? "Preview could not be loaded." : "Opening preview…"}</p>
        {failed && (
          <button
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            Retry
          </button>
        )}
        {exit}
      </main>
    );
  return (
    <Player
      key={visit}
      exhibition={snapshot}
      previewControls={
        <>
          <button onClick={() => setVisit(visit + 1)}>Restart preview</button>
          {exit}
        </>
      }
    />
  );
}
