import { useEffect, useState } from "react";
import type { ModeManager, ModeManagerState } from "./graphics/modeManager";

interface AppProps {
  manager: ModeManager;
}

export function App({ manager }: AppProps) {
  const [state, setState] = useState<ModeManagerState>(manager.getState());

  useEffect(() => manager.subscribe(setState), [manager]);

  const visitor = state.mode === "visitor";

  return (
    <main>
      <h1>VThere</h1>
      <p>
        {visitor
          ? "Visitor mode — drag to look, arrows to move"
          : "Spatial experience editor"}
      </p>
      <div className="mode-actions">
        {visitor ? (
          <button onClick={() => manager.setMode("editor")}>Exit Visitor</button>
        ) : (
          <button onClick={() => manager.setMode("visitor")}>Enter Visitor</button>
        )}
      </div>
    </main>
  );
}