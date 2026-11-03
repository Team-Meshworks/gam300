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

// Keep the administration preview local until its backend and host route are connected
// Production builds discard this branch and its in-memory test adapter
if (import.meta.env.DEV && new URLSearchParams(location.search).has("asset-admin-test")) {
  void import("./asset-administration/AssetAdministrationPreview").then(
    ({ AssetAdministrationPreview }) => {
      document.documentElement.classList.add("asset-admin-preview-page");
      createRoot(root).render(<AssetAdministrationPreview />);
    },
  );
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
