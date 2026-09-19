import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export function initScene(): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111827);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 1.5, 3.5);
  camera.lookAt(0, 0.5, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

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
      camera.lookAt(0, size.y / 2, 0);
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

  const animate = () => {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };
  animate();
}