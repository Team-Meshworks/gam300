import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

const projectId = new URLSearchParams(location.search).get("projectId");
if (!projectId) throw new Error("The editor requires a project ID");
createRoot(root).render(
  <StrictMode>
    <ServerProjectEditor projectId={projectId} />
  </StrictMode>,
);
