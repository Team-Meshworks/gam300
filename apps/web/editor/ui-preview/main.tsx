import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "@fortawesome/fontawesome-svg-core";
import "../../shared/ui/foundation.css";
import "./preview.css";
import { FoundationPreview } from "./FoundationPreview";
import { preloadUiSounds } from "../audio/ui-sounds";

config.autoAddCss = false;
preloadUiSounds("goingBack", "save");
const root = document.getElementById("root");
if (!root) throw new Error("The preview root is missing");
// This separate HTML entry is deliberately excluded from the editor build inputs
if (import.meta.env.DEV)
  createRoot(root).render(
    <StrictMode>
      <FoundationPreview />
    </StrictMode>,
  );
