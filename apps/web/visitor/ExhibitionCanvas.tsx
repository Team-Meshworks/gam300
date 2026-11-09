import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { FpsControls, type FpsMobileControls } from "../shared/preview/FpsControls";
import { MobileControls } from "../shared/preview/MobileControls";
import { standOnPreviewFloor } from "../shared/preview/preview-start";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STARTER_ROOM_SHA256 } from "../shared/asset-runtime/catalogue";
import { disposeModels } from "../shared/asset-runtime/ModelCache";
import { createExhibitAppearance } from "../shared/asset-runtime/exhibit-appearance";
import { createTextTexture } from "../shared/asset-runtime/text-texture";
import { createRoomEntrances } from "../shared/asset-runtime/room-entrances";
import type { PublishedExhibition } from "./publication";
import { createVisitorPlayback } from "./visitor-playback";
import { fetchPublicationAsset } from "./publication-asset";

export function ExhibitionCanvas({
  exhibition,
  sceneIndex,
  viewpoint,
  navigate,
}: {
  exhibition: PublishedExhibition;
  sceneIndex: number;
  navigate: (sceneId: string, viewpointId: string) => void;
  viewpoint?: Readonly<{ id: string }> | undefined;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const play = useRef<() => void>(() => {});
  const reset = useRef<() => void>(() => {});
  const selectView = useRef<(id: string) => void>(() => {});
  const [attempt, setAttempt] = useState(0);
  const [mobile, setMobile] = useState<FpsMobileControls | null>(null);
  const [captured, setCaptured] = useState(false);
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
    const fps = new FpsControls(camera, renderer.domElement);
    fps.setFlightAllowed(false);
    fps.onCaptureChange = () => setCaptured(fps.isCaptured());
    const controls = { target: new THREE.Vector3(), update: () => fps.syncFromCamera() };
    queueMicrotask(() => {
      if (!controller.signal.aborted) setMobile(fps.mobileControls);
    });
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
    const start = () => {
      setView(starting);
      if (!viewpoint?.id && !("startViewpointId" in source && source.startViewpointId)) {
        standOnPreviewFloor(camera, fps);
      }
    };
    selectView.current = (id) => {
      const view = source.viewpoints?.find((item) => item.id === id);
      if (view) setView(view.camera);
    };
    reset.current = start;
    start();
    scene.background = new THREE.Color("#e9e5db");
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
    const roots = new Map<string, THREE.Object3D>();
    let playback: ReturnType<typeof createVisitorPlayback> | undefined;
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lastFrame = performance.now();
    // Resolve visible model owners from child geometry for click and gaze triggers
    const picked = () => {
      for (const hit of ray.intersectObjects([...roots.values()], true)) {
        let node: THREE.Object3D | null = hit.object;
        let visible = true;
        while (node) {
          if (!node.visible) visible = false;
          if (roots.get(node.name) === node && visible) return node.name;
          node = node.parent;
        }
      }
      return undefined;
    };
    // Looking around never activates an exhibit at the end of a drag
    let press = { x: 0, y: 0 };
    const down = (event: PointerEvent) => {
      press = { x: event.clientX, y: event.clientY };
    };
    const click = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (fps.isCaptured()) pointer.set(0, 0);
      else
        pointer.set(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        );
      ray.setFromCamera(pointer, camera);
      const id = picked();
      if (id) {
        playback?.click(id);
        document
          .querySelector<HTMLElement>(`[data-exhibition-scene="${source.id}"]`)
          ?.dispatchEvent(new CustomEvent("exhibit-inspect", { detail: id }));
      } else playback?.start();
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", click);
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      if (!document.hidden) fps.update(Math.min(0.1, (now - lastFrame) / 1000));
      ray.setFromCamera(new THREE.Vector2(), camera);
      playback?.update(Math.min(0.1, (now - lastFrame) / 1000), picked());
      lastFrame = now;
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
    const appearances = createExhibitAppearance();
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
        // Approved rooms use the same floor-centered model origin as the editor
        // Apply it inside the authored root so its saved world transform stays unchanged
        if (asset.placement === "bottom-center") {
          const box = new THREE.Box3().setFromObject(gltf.scene);
          const center = box.getCenter(new THREE.Vector3());
          gltf.scene.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
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
        const authored =
          "rules" in source ? source.objects.find((item) => item.id === object.id) : undefined;
        if (authored && "appearance" in authored) appearances.apply(root, authored.appearance);
        // Placed text uses the editor's formatting and local placement on its exhibit
        if (authored && "components" in authored) {
          for (const component of authored.components) {
            if (component.type !== "text" || !component.placement) continue;
            const placement = component.placement;
            const texture = createTextTexture(
              "",
              placement.scale[0],
              placement.scale[1],
              component.runs,
              (component.fontSize ?? 24) * 4,
              component.background === "transparent",
              component.color ?? "#292522",
              component.background ?? "#fffaf0",
            );
            const panel = new THREE.Mesh(
              new THREE.PlaneGeometry(placement.scale[0], placement.scale[1]),
              new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.DoubleSide,
                toneMapped: false,
                transparent: component.background === "transparent",
              }),
            );
            panel.position.fromArray(placement.position);
            panel.quaternion.fromArray(placement.rotation);
            panel.translateZ(0.004);
            root.add(panel);
          }
        }
        scene.add(root);
        roots.set(object.id, root);
        // Markers attach in object-local coordinates and follow the saved model transform
        for (const hotspot of ("hotspots" in source ? source.hotspots : []).filter(
          (item) => item.objectId.toLowerCase() === object.id.toLowerCase(),
        )) {
          const marker = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 12, 8),
            new THREE.MeshBasicMaterial({ color: "#b45b34" }),
          );
          marker.position.fromArray(hotspot.position);
          root.add(marker);
        }
        if (root.visible && digest === STARTER_ROOM_SHA256) {
          rooms.push(root);
        }
      }
      if (!controller.signal.aborted) {
        entrances.sync(rooms);
        const information = document.querySelector<HTMLElement>(
          `[data-exhibition-scene="${source.id}"]`,
        );
        if (information) {
          playback = createVisitorPlayback(
            source,
            camera,
            controls,
            roots,
            information,
            navigate,
            (message) => {
              if (!controller.signal.aborted)
                setResult({ exhibition, sceneIndex, attempt, viewpoint, message, failed: false });
            },
          );
          play.current = playback.start;
          playback.begin();
        }
        fps.engage();
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
        appearances.dispose();
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
      playback?.dispose();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", click);
      play.current = () => {};
      size.disconnect();
      renderer.setAnimationLoop(null);
      fps.dispose();
      entrances.dispose();
      appearances.dispose();
      disposeModels(scene);
      renderer.dispose();
      renderer.domElement.remove();
      reset.current = () => {};
      selectView.current = () => {};
    };
  }, [exhibition, sceneIndex, viewpoint, attempt]);
  return (
    <section className="visitor-viewer" aria-label="Exhibition viewer">
      <p
        className={current?.message === "Exhibition ready" ? "sr-only" : "visitor-status"}
        role="status"
      >
        {current?.message ?? "Loading exhibition…"}
      </p>
      {current?.failed && (
        <button onClick={() => setAttempt((previous) => previous + 1)}>
          Retry loading exhibition
        </button>
      )}
      <div className="visitor-controls">
        <button onClick={() => play.current()}>Enable audio</button>
        <button onClick={() => reset.current()}>Reset view</button>
        {exhibition.document.scenes[sceneIndex]?.viewpoints?.map((view) => (
          <button key={view.id} onClick={() => selectView.current(view.id)}>
            {view.name}
          </button>
        ))}
      </div>
      {current && !current.failed && (
        <>
          {captured && <span className="crosshair" aria-hidden="true" />}
          <p className="walk-hint">
            <span className="visitor-desktop-hint">
              {captured
                ? "Preview mode · Click to interact · Hold Alt for the mouse · Esc to stop"
                : "Preview mode · Click or drag to look around · WASD to walk · Space to jump"}
            </span>
            <span className="visitor-touch-hint">
              Preview mode · Use Move and Look to explore · Tap an exhibit to interact
            </span>
          </p>
          {mobile && <MobileControls controls={mobile} allowFlight={false} />}
        </>
      )}
      <div
        className="visitor-canvas"
        ref={mount}
        style={{ visibility: current && !current.failed ? "visible" : "hidden" }}
      />
    </section>
  );
}
