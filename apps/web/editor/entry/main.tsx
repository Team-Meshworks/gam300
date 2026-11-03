import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "@fortawesome/fontawesome-svg-core";
import "../../shared/ui/foundation.css";
import "./entry.css";
import { preloadUiSounds } from "../audio/ui-sounds";
import { LandingPage } from "./LandingPage";
import { LoginPage } from "./LoginPage";

config.autoAddCss = false;
const root = document.getElementById("root");
if (!root) throw new Error("The entry page root is missing");
const login = /^\/login\/?$/.test(location.pathname);
document.title = login ? "Log in · Spatia" : "Spatia · Interactive learning";
if (login) preloadUiSounds("goingBack");
createRoot(root).render(<StrictMode>{login ? <LoginPage /> : <LandingPage />}</StrictMode>);
