import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FpsControls } from "./controls/fpsControls";
import { ModeManager } from "./graphics/modeManager";
import { createScene } from "./graphics/scene";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The editor root element is missing");
}

const { scene, camera, renderer, orbit, fpsMeter } = createScene();
const fpsControls = new FpsControls(camera, renderer.domElement);
const modeManager = new ModeManager(camera, orbit, fpsControls);

createRoot(root).render(
  <StrictMode>
    <App manager={modeManager} />
  </StrictMode>,
);

let lastFrameTime = performance.now();

const animate = (now: number) => {
  requestAnimationFrame(animate);
  const delta = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  modeManager.update(delta);
  renderer.render(scene, camera);
  fpsMeter.tick(now);
};

requestAnimationFrame(animate);
