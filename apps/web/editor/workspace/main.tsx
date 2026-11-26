import "../../shared/ui/inter-font.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "@fortawesome/fontawesome-svg-core";
import "../../shared/ui/foundation.css";
import "./workspace.css";
import { WorkspaceLoading } from "../accounts/WorkspaceLoading";
import { WorkspacePage } from "./WorkspacePage";
import { preloadUiSounds } from "../audio/ui-sounds";

config.autoAddCss = false;
preloadUiSounds("goingBack", "save");
const root = document.getElementById("root");
if (!root) throw new Error("The workspace root is missing");
const app = createRoot(root);
app.render(<WorkspaceLoading />);
// Load the existing font weights before the catalogue's first visible frame.
void Promise.all([400, 500, 600, 700].map((weight) => document.fonts.load(`${weight} 14px Inter`)))
  .catch(() => undefined)
  .then(() => {
    app.render(
      <StrictMode>
        <WorkspacePage />
      </StrictMode>,
    );
  });
