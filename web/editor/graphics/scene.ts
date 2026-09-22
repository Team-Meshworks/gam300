import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface FpsMeter {
  tick(now: number): void;
}

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  orbit: OrbitControls;
  fpsMeter: FpsMeter;
}

export function createScene(): SceneContext {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111827);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 1.5, 3.5);
  camera.lookAt(0, 0.5, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.target.set(0, 0.5, 0);

  const fpsMeter = createFpsMeter();

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));

  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-3, 1, -3);
  scene.add(fill);

  const loader = new GLTFLoader();
  loader.load(
    "/models/snowglobe.glb",
    (gltf) => {
      const model = gltf.scene;

      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      model.position.sub(center).add(new THREE.Vector3(0, size.y / 2, 0));
      scene.add(model);

      const fitDistance = size.length() / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.position.set(0, size.y * 0.45, fitDistance);
      orbit.target.set(0, size.y / 2, 0);
      orbit.update();
    },
    undefined,
    (error) => {
      console.error("Failed to load /models/snowglobe.glb", error);
    },
  );

  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener("resize", onResize);

  return { scene, camera, renderer, orbit, fpsMeter };
}

function createFpsMeter(): FpsMeter {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "fixed",
    top: "0.75rem",
    right: "0.75rem",
    padding: "0.25rem 0.5rem",
    borderRadius: "0.375rem",
    background: "rgba(17, 24, 39, 0.6)",
    color: "#f5f7fa",
    font: "0.75rem/1.4 system-ui, sans-serif",
    zIndex: "2",
    opacity: "0.8",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);

  let frameCount = 0;
  let lastFpsTime = performance.now();

  return {
    tick(now: number): void {
      frameCount += 1;
      const elapsed = now - lastFpsTime;
      if (elapsed >= 500) {
        el.textContent = `${Math.round((frameCount * 1000) / elapsed)} fps`;
        frameCount = 0;
        lastFpsTime = now;
      }
    },
  };
}
