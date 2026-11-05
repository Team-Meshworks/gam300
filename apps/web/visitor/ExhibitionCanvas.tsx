import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { disposeModels } from "../shared/asset-runtime/ModelCache";
import type { PublishedExhibition } from "./publication";
import { fetchPublicationAsset } from "./publication-asset";

export function ExhibitionCanvas({
  exhibition,
  sceneIndex,
}: {
  exhibition: PublishedExhibition;
  sceneIndex: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const selectView = useRef<(id: string) => void>(() => {});
  const [status, setStatus] = useState("Loading exhibition…");
  useEffect(() => {
    const host = mount.current;
    const source = exhibition.document.scenes[sceneIndex];
    if (!host || !source) return;
    const controller = new AbortController();
    const scene = new THREE.Scene();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      queueMicrotask(() =>
        setStatus(
          "This browser cannot display the 3D exhibition. Try a browser with WebGL enabled.",
        ),
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.setAttribute("aria-label", "Exhibition view");
    renderer.domElement.tabIndex = 0;
    host.append(renderer.domElement);
    const starting =
      source.viewpoints?.find((view) => view.id === source.startViewpointId)?.camera ??
      source.startCamera;
    const camera = new THREE.PerspectiveCamera(starting.fovDegrees, 1, 0.01, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const setView = (pose: typeof starting) => {
      camera.position.fromArray(pose.position);
      camera.quaternion.fromArray(pose.rotation);
      camera.fov = pose.fovDegrees;
      camera.updateProjectionMatrix();
      controls.target
        .copy(camera.position)
        .add(new THREE.Vector3(0, 0, -5).applyQuaternion(camera.quaternion));
      controls.update();
    };
    const start = () => setView(starting);
    selectView.current = (id) => {
      const view = source.viewpoints?.find((item) => item.id === id);
      if (view) setView(view.camera);
    };
    reset.current = start;
    start();
    scene.background = new THREE.Color("#edf2f4");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x788493, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(5, 12, 8);
    scene.add(sun);
    const size = new ResizeObserver(() => {
      const width = host.clientWidth,
        height = host.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    });
    size.observe(host);
    const keys = (event: KeyboardEvent) => {
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-0.5, 0],
        ArrowRight: [0.5, 0],
        ArrowUp: [0, -0.5],
        ArrowDown: [0, 0.5],
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      const movement = new THREE.Vector3(delta[0], 0, delta[1]).applyQuaternion(camera.quaternion);
      camera.position.add(movement);
      controls.target.add(movement);
      controls.update();
    };
    renderer.domElement.addEventListener("keydown", keys);
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
    const objects = [
      ...(source.environmentAssetId
        ? [{ assetId: source.environmentAssetId, transform: null }]
        : []),
      ...source.objects,
    ];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith("blob:") && !url.startsWith("data:"))
        throw new Error("External exhibition resources are unsupported.");
      return url;
    });
    const loader = new GLTFLoader(manager);
    void (async () => {
      for (const object of objects) {
        const asset = exhibition.assets.find((row) => row.id === object.assetId);
        if (!asset) throw new Error("An exhibition asset is missing.");
        const response = await fetchPublicationAsset(asset.url, controller.signal);
        if (!response.ok)
          throw new Error("An exhibition asset is unavailable. Your access may have changed.");
        const bytes = await response.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== asset.sha256) throw new Error("An exhibition asset could not be verified.");
        const gltf = await loader.parseAsync(bytes, "");
        if (controller.signal.aborted) {
          disposeModels(gltf.scene);
          return;
        }
        const root = new THREE.Group();
        root.add(gltf.scene);
        if (object.transform) {
          root.position.fromArray(object.transform.position);
          root.quaternion.fromArray(object.transform.rotation);
          root.scale.fromArray(object.transform.scale);
        }
        scene.add(root);
      }
      if (!controller.signal.aborted) setStatus("Exhibition ready");
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        disposeModels(scene);
        scene.clear();
        setStatus(
          failure instanceof Error ? failure.message : "The exhibition could not be loaded.",
        );
      }
    });
    return () => {
      controller.abort();
      size.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener("keydown", keys);
      controls.dispose();
      disposeModels(scene);
      renderer.dispose();
      renderer.domElement.remove();
      reset.current = () => {};
      selectView.current = () => {};
    };
  }, [exhibition, sceneIndex]);
  return (
    <section aria-label="Exhibition viewer">
      <p role="status">{status}</p>
      <p>
        Drag to look around, scroll or pinch to zoom. Focus the view and use the arrow keys to move.
      </p>
      <button onClick={() => reset.current()}>Reset view</button>
      {exhibition.document.scenes[sceneIndex]?.viewpoints?.map((view) => (
        <button key={view.id} onClick={() => selectView.current(view.id)}>
          {view.name}
        </button>
      ))}
      <div className="visitor-canvas" ref={mount} />
    </section>
  );
}
