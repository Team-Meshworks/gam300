import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "@fortawesome/fontawesome-svg-core";
import "../../shared/ui/foundation.css";
import "./entry.css";
import { preloadUiSounds } from "../audio/ui-sounds";
import { LandingPage } from "./LandingPage";
import { LoginPage } from "./LoginPage";
import { HomePage } from "../home/HomePage";

config.autoAddCss = false;
const root = document.getElementById("root");
if (!root) throw new Error("The entry page root is missing");
const siteRoot = location.pathname === "/" || location.pathname === "/index.html";
const login = siteRoot || /^\/login\/?$/.test(location.pathname);
const home = /^\/home\/?$/.test(location.pathname);
document.title = home
  ? "Projects · Spatia"
  : login
    ? "Log in · Spatia"
    : "Spatia · Interactive learning";
if (login) preloadUiSounds("goingBack");
createRoot(root).render(
  <StrictMode>
    {home ? <HomePage /> : login ? <LoginPage siteRoot={siteRoot} /> : <LandingPage />}
  </StrictMode>,
);
