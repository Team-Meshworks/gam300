import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
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
    <App />
  </StrictMode>,
);
