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
// Load the existing font weights before the catalogue's first visible frame.
void Promise.all([400, 500, 600, 700].map((weight) => document.fonts.load(`${weight} 14px Inter`)))
  .catch(() => undefined)
  .then(() => {
    createRoot(root).render(
      <StrictMode>
        <WorkspacePage />
      </StrictMode>,
    );
  });
