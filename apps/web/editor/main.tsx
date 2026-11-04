import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ServerProjectEditor } from "./ServerProjectEditor";
import { preloadUiSounds } from "./audio/ui-sounds";
import "./styles.css";

preloadUiSounds(
  "assetPlace",
  "assetSelect",
  "delete",
  "enterPreview",
  "goingBack",
  "save",
  "warning",
);

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The editor root element is missing");
}

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).has("projectId") ? (
      <ServerProjectEditor
        projectId={new URLSearchParams(location.search).get("projectId") ?? ""}
      />
    ) : (
      <App />
    )}
  </StrictMode>,
);
