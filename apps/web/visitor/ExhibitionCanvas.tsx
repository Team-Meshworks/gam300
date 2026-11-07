import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STARTER_ROOM_SHA256 } from "../shared/asset-runtime/catalogue";
import { disposeModels } from "../shared/asset-runtime/ModelCache";
import { createRoomEntrances } from "../shared/asset-runtime/room-entrances";
import type { PublishedExhibition } from "./publication";
import { fetchPublicationAsset } from "./publication-asset";

export function ExhibitionCanvas({
  exhibition,
  sceneIndex,
  viewpoint,
}: {
  exhibition: PublishedExhibition;
  sceneIndex: number;
  viewpoint?: Readonly<{ id: string }> | undefined;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const selectView = useRef<(id: string) => void>(() => {});
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    exhibition: PublishedExhibition;
    sceneIndex: number;
    attempt: number;
    viewpoint: typeof viewpoint;
    message: string;
    failed: boolean;
  } | null>(null);
  const current =
    result?.exhibition === exhibition &&
    result.sceneIndex === sceneIndex &&
    result.attempt === attempt &&
    result.viewpoint === viewpoint
      ? result
      : null;
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
      queueMicrotask(() => {
        if (!controller.signal.aborted)
          setResult({
            exhibition,
            sceneIndex,
            attempt,
            viewpoint,
            message:
              "This browser cannot display the 3D exhibition. Try a browser with WebGL enabled.",
            failed: true,
          });
      });
      return () => controller.abort();
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.setAttribute("aria-label", "Exhibition view");
    renderer.domElement.tabIndex = 0;
    host.append(renderer.domElement);

    // A navigation point can choose a saved view; ordinary scene changes use the scene's starting camera
    const starting =
      source.viewpoints?.find(
        (view) =>
          view.id.toLowerCase() ===
          (
            viewpoint?.id ?? ("startViewpointId" in source ? source.startViewpointId : undefined)
          )?.toLowerCase(),
      )?.camera ?? source.startCamera;
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

    // Put the environment through the same transform and visibility path as placed objects
    const objects = [
      ...(source.environmentAssetId
        ? [
            {
              id: source.id,
              assetId: source.environmentAssetId,
              transform: "environmentTransform" in source ? source.environmentTransform : undefined,
              visible: !("environmentVisible" in source) || source.environmentVisible !== false,
            },
          ]
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
    const entrances = createRoomEntrances();
    const rooms: THREE.Group[] = [];
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

        // Keep authored IDs on the rendered roots without changing the saved object data
        root.name = object.id;
        root.visible = !("visible" in object) || object.visible !== false;
        root.add(gltf.scene);
        if (object.transform) {
          root.position.fromArray(object.transform.position);
          root.quaternion.fromArray(object.transform.rotation);
          root.scale.fromArray(object.transform.scale);
        }
        scene.add(root);
        if (root.visible && digest === STARTER_ROOM_SHA256) {
          rooms.push(root);
        }
      }
      if (!controller.signal.aborted) {
        entrances.sync(rooms);
        setResult({
          exhibition,
          sceneIndex,
          attempt,
          viewpoint,
          message: "Exhibition ready",
          failed: false,
        });
      }
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        entrances.dispose();
        disposeModels(scene);
        scene.clear();
        setResult({
          exhibition,
          sceneIndex,
          attempt,
          viewpoint,
          message:
            failure instanceof DOMException && failure.name === "TimeoutError"
              ? "Loading the exhibition timed out. Please try again."
              : failure instanceof Error
                ? failure.message
                : "The exhibition could not be loaded.",
          failed: true,
        });
      }
    });
    return () => {
      controller.abort();
      size.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener("keydown", keys);
      controls.dispose();
      entrances.dispose();
      disposeModels(scene);
      renderer.dispose();
      renderer.domElement.remove();
      reset.current = () => {};
      selectView.current = () => {};
    };
  }, [exhibition, sceneIndex, viewpoint, attempt]);
  return (
    <section aria-label="Exhibition viewer">
      <p role="status">{current?.message ?? "Loading exhibition…"}</p>
      {current?.failed && (
        <button onClick={() => setAttempt((previous) => previous + 1)}>
          Retry loading exhibition
        </button>
      )}
      <p>
        Drag to look around, scroll or pinch to zoom. Focus the view and use the arrow keys to move.
      </p>
      <button onClick={() => reset.current()}>Reset view</button>
      {exhibition.document.scenes[sceneIndex]?.viewpoints?.map((view) => (
        <button key={view.id} onClick={() => selectView.current(view.id)}>
          {view.name}
        </button>
      ))}
      <div
        className="visitor-canvas"
        ref={mount}
        style={{ visibility: current && !current.failed ? "visible" : "hidden" }}
      />
    </section>
  );
}
