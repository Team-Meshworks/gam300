import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initScene } from "./graphics/scene";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The editor root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initScene();
