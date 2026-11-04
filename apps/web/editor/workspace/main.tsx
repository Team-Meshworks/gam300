import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "@fortawesome/fontawesome-svg-core";
import "../../shared/ui/foundation.css";
import "./workspace.css";
import { WorkspacePage } from "./WorkspacePage";
import { preloadUiSounds } from "../audio/ui-sounds";

config.autoAddCss = false;
preloadUiSounds("goingBack", "save");
const root = document.getElementById("root");
if (!root) throw new Error("The workspace root is missing");
createRoot(root).render(
  <StrictMode>
    <WorkspacePage />
  </StrictMode>,
);
