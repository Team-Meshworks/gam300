import { displaySurface } from "../asset-runtime/display-surface";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createActiveClock } from "../preview/active-clock";
import { FpsControls, type FpsMobileControls } from "../preview/FpsControls";
import { MobileControls } from "../preview/MobileControls";
import { standOnPreviewFloor } from "../preview/preview-start";
import { createWalkSpace, type WalkProp } from "../preview/walk-space";
import { isRoomModel, knownRoomGeometry, STARTER_ROOM_SHA256 } from "../asset-runtime/catalogue";
import { addNonBlockingHitbox } from "../asset-runtime/non-blocking";
import { disposeModels, visibleModelBounds } from "../asset-runtime/ModelCache";
import { createExhibitAppearance } from "../asset-runtime/exhibit-appearance";
import { containDisplay } from "../asset-runtime/display-layout";
import { createDisplayText } from "../asset-runtime/display-text";
import { createRoomEntrances } from "../asset-runtime/room-entrances";
import {
  attachHotspotSprite,
  disposeHotspotSprite,
  loadHotspotSprite,
} from "../asset-runtime/hotspot-sprite";
import { fitRoomFog, lightExhibitionScene } from "../asset-runtime/scene-lighting";
import type { PlayerSnapshot } from "./player-snapshot";
import { createVisitorPlayback } from "./playback";
import type { createPlayerGraphics } from "./player-graphics";

export function ExhibitionCanvas({
  graphics,
  exhibition,
  sceneIndex,
  viewpoint,
  navigate,
  beginNavigationEvent,
  onPlaybackReady,
}: {
  graphics: ReturnType<typeof createPlayerGraphics>;
  exhibition: PlayerSnapshot;
  sceneIndex: number;
  navigate: (sceneId: string, viewpointId: string, deliberate: boolean) => boolean;
  beginNavigationEvent(): void;
  onPlaybackReady(ready: boolean): void;
  viewpoint?: Readonly<{ id: string }> | undefined;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const selectView = useRef<(id: string) => void>(() => {});
  const [entryView] = useState(viewpoint);
  const [attempt, setAttempt] = useState(0);
  const [mobile, setMobile] = useState<FpsMobileControls | null>(null);
  const [captured, setCaptured] = useState(false);
  const [result, setResult] = useState<{
    exhibition: PlayerSnapshot;
    sceneIndex: number;
    attempt: number;
    message: string;
    failed: boolean;
  } | null>(null);
  const current =
    result?.exhibition === exhibition &&
    result.sceneIndex === sceneIndex &&
    result.attempt === attempt
      ? result
      : null;
  useEffect(() => {
    const host = mount.current;
    const source = exhibition.document.scenes[sceneIndex];
    if (!host || !source) return;
    const controller = new AbortController();
    const { scene, camera } = graphics;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = graphics.getRenderer();
    } catch {
      queueMicrotask(() => {
        if (!controller.signal.aborted)
          setResult({
            exhibition,
            sceneIndex,
            attempt,

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
            entryView?.id ?? ("startViewpointId" in source ? source.startViewpointId : undefined)
          )?.toLowerCase(),
      )?.camera ?? source.startCamera;
    const fps = new FpsControls(camera, renderer.domElement);
    fps.setFlightAllowed(false);
    fps.onNavigationInput = beginNavigationEvent;
    fps.onCaptureChange = () => setCaptured(fps.isCaptured());
    let resumeInput = false;
    const modalInput = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail) {
        resumeInput = fps.isEngaged();
        fps.disengage();
      } else if (resumeInput) {
        resumeInput = false;
        fps.engage();
      }
    };
    const preview = host.closest(".visitor-preview");
    preview?.addEventListener("exhibit-modal", modalInput);
    const controls = {
      target: new THREE.Vector3(),
      update: () => fps.syncFromCamera(),
    };
    queueMicrotask(() => {
      if (!controller.signal.aborted) setMobile(fps.mobileControls);
    });
    const setView = (pose: typeof starting, standOnFloor = false) => {
      camera.position.fromArray(pose.position);
      camera.quaternion.fromArray(pose.rotation);
      camera.fov = pose.fovDegrees;
      camera.updateProjectionMatrix();
      if (standOnFloor) standOnPreviewFloor(camera, fps);
      controls.target
        .copy(camera.position)
        .add(new THREE.Vector3(0, 0, -5).applyQuaternion(camera.quaternion));
      controls.update();
    };
    const start = () =>
      setView(
        starting,
        !entryView?.id && !("startViewpointId" in source && source.startViewpointId),
      );
    selectView.current = (id) => {
      const view = source.viewpoints?.find((item) => item.id.toLowerCase() === id.toLowerCase());
      if (view) setView(view.camera);
    };
    start();
    const { fog } = lightExhibitionScene(scene);
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
    const waitingForMedia = new Set<() => boolean>();
    let lastFrame = performance.now();
    const clock = createActiveClock(lastFrame, !document.hidden);
    const visibilityChanged = () => {
      lastFrame = performance.now();
      clock.setActive(lastFrame, !document.hidden);
    };
    document.addEventListener("visibilitychange", visibilityChanged);
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
    let press: { id: number; x: number; y: number; locked: boolean; distance: number } | undefined;
    const cancelPress = () => {
      press = undefined;
    };
    const down = (event: PointerEvent) => {
      cancelPress();
      // Pointerdown precedes the FPS mousedown which requests capture; that gesture only enters look mode
      if (event.button !== 0 || !event.isPrimary) return;
      playback?.start();
      if (fps.wantsCapture(event)) return;
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        locked: fps.isCaptured(),
        distance: 0,
      };
    };
    const move = (event: PointerEvent) => {
      if (!press || press.id !== event.pointerId) return;
      const dx = press.locked ? event.movementX : event.clientX - press.x;
      const dy = press.locked ? event.movementY : event.clientY - press.y;
      // Accumulate travel rather than displacement so looking away and back still counts as a drag
      press.distance += Math.hypot(dx, dy);
      press.x = event.clientX;
      press.y = event.clientY;
    };
    const click = (event: PointerEvent) => {
      const gesture = press;
      cancelPress();
      if (
        !gesture ||
        gesture.id !== event.pointerId ||
        event.button !== 0 ||
        !event.isPrimary ||
        gesture.locked !== fps.isCaptured() ||
        !Number.isFinite(gesture.distance) ||
        gesture.distance + Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5
      )
        return;
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
        host
          .closest(".visitor-preview")
          ?.querySelector<HTMLElement>(`[data-exhibition-scene="${source.id}"]`)
          ?.dispatchEvent(new CustomEvent("exhibit-inspect", { detail: id }));
      } else if (event.pointerType !== "mouse") {
        // Touch and pen gain user activation on release. A blank tap has no exhibit click to retry audio.
        playback?.start();
      }
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", click);
    renderer.domElement.addEventListener("lostpointercapture", cancelPress);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", cancelPress);
    document.addEventListener("pointercancel", cancelPress);
    document.addEventListener("pointerlockchange", cancelPress);
    document.addEventListener("visibilitychange", cancelPress);
    window.addEventListener("blur", cancelPress);
    const hasGaze =
      "rules" in source &&
      source.rules.some((rule) => rule.enabled && rule.trigger.type === "gaze");
    const center = new THREE.Vector2();
    renderer.setAnimationLoop(() => {
      if (document.hidden) return;
      const now = performance.now();
      fps.update(Math.min(0.1, (now - lastFrame) / 1000));
      const elapsed = clock.tick(now);
      if (hasGaze && playback) ray.setFromCamera(center, camera);
      playback?.update(elapsed, hasGaze ? picked() : undefined);
      lastFrame = now;
      for (const bind of waitingForMedia) if (bind()) waitingForMedia.delete(bind);
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
    const models = graphics.openScene(controller.signal);
    const entrances = createRoomEntrances();
    const appearances = createExhibitAppearance();
    const rooms = new Map<THREE.Object3D, { model: THREE.Object3D; starter: boolean }>();
    const assetsById = new Map(exhibition.assets.map((asset) => [asset.id, asset]));
    const nonBlockingIds = new Set(
      exhibition.assets
        .filter((asset) => asset.nonBlocking === true)
        .map((asset) => asset.id.toLowerCase()),
    );
    const props: WalkProp[] = [];
    const propBounds = new Map<string, THREE.Box3>();
    function syncRooms() {
      const visible = [...rooms].filter(([root]) => root.visible);
      entrances.sync(visible.filter(([, room]) => room.starter).map(([root]) => root));
      fps.setWalkSpace(
        visible.length || props.length
          ? createWalkSpace(
              visible.map(([, room]) => room.model),
              props,
            )
          : undefined,
      );
    }
    const hotspots = "hotspots" in source ? source.hotspots : [];
    let hotspotTemplate: THREE.Sprite | undefined;
    let failed = false;
    void (async () => {
      if (hotspots.length) {
        const sprite = await loadHotspotSprite();
        if (controller.signal.aborted) {
          disposeHotspotSprite(sprite);
          return;
        }
        hotspotTemplate = sprite;
      }
      for (const object of objects) {
        const asset = assetsById.get(object.assetId);
        if (!asset) throw new Error("An exhibition asset is missing.");
        const model = await models.instantiate(asset);
        if (controller.signal.aborted) return;
        if (asset.nonBlocking === true) addNonBlockingHitbox(model);
        const digest = asset.sha256.toLowerCase();
        const root = new THREE.Group();

        // Keep authored IDs on the rendered roots without changing the saved object data
        root.name = object.id;
        root.visible = !("visible" in object) || object.visible !== false;
        root.add(model);
        scene.add(root);
        if (
          asset.kind === "environment" ||
          (asset.kind === "model" &&
            (knownRoomGeometry.has(digest) || isRoomModel(exhibition.assets, asset.id)))
        ) {
          rooms.set(root, { model: model, starter: digest === STARTER_ROOM_SHA256 });
        } else if (asset.kind === "model" && asset.nonBlocking !== true) {
          let bounds = propBounds.get(asset.id);
          if (!bounds) {
            bounds = visibleModelBounds(model);
            propBounds.set(asset.id, bounds);
          }
          if (!bounds.isEmpty()) props.push({ root, bounds });
        }
        // Measure display surfaces in model-local coordinates before applying the authored root transform
        const localSurface =
          asset.displayRole === "physical" ? new THREE.Box3().setFromObject(model) : undefined;
        if (object.transform) {
          root.position.fromArray(object.transform.position);
          root.quaternion.fromArray(object.transform.rotation);
          root.scale.fromArray(object.transform.scale);
        }
        if (object.id === source.id && root.visible)
          fitRoomFog(fog, new THREE.Box3().setFromObject(root));
        const authored =
          "rules" in source ? source.objects.find((item) => item.id === object.id) : undefined;
        if (authored && "appearance" in authored) appearances.apply(root, authored.appearance);
        // Attach the same verified media element used by the information panel and rule actions
        const surface = asset.displaySurface;
        if (authored && surface) {
          const component = authored.components.find(
            (item) => item.type === "image" || item.type === "video",
          );
          if (component) {
            waitingForMedia.add(() => {
              const element = host
                .closest(".visitor-preview")
                ?.querySelector(
                  `[data-component-id="${component.id}"] img, [data-component-id="${component.id}"] video`,
                );
              const image =
                element instanceof HTMLImageElement && element.naturalWidth > 0 ? element : null;
              const video =
                element instanceof HTMLVideoElement && element.readyState >= 2 ? element : null;
              if (!image && !video) return false;
              const map = video ? new THREE.VideoTexture(video) : new THREE.Texture(image);
              map.colorSpace = THREE.SRGBColorSpace;
              map.needsUpdate = true;
              const fit = containDisplay(
                surface.width,
                surface.height,
                video?.videoWidth ?? image!.naturalWidth,
                video?.videoHeight ?? image!.naturalHeight,
              );
              const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(fit.width, fit.height),
                new THREE.MeshBasicMaterial({
                  map,
                  side: THREE.DoubleSide,
                  toneMapped: false,
                }),
              );
              mesh.position.fromArray(surface.position);
              mesh.quaternion.fromArray(surface.rotation);
              mesh.translateZ(0.004);
              root.add(mesh);
              return true;
            });
          }
        }
        // Placed text uses the editor's formatting and local placement on its exhibit
        if (authored && "components" in authored) {
          for (const component of authored.components) {
            if (component.type !== "text") continue;
            const face = displaySurface(asset, component, localSurface);
            if (!face) continue;
            root.add(
              createDisplayText(
                face,
                component,
                asset.displayRole === "physical",
                authored.appearance,
              ),
            );
          }
        }
        roots.set(object.id, root);
        // Markers attach in object-local coordinates and follow the saved model transform
        for (const hotspot of hotspots) {
          if (hotspotTemplate && hotspot.objectId.toLowerCase() === object.id.toLowerCase())
            attachHotspotSprite(hotspotTemplate.clone(), root, hotspot.position);
        }
      }
      if (!controller.signal.aborted) {
        syncRooms();
        const information = host
          .closest(".visitor-preview")
          ?.querySelector<HTMLElement>(`[data-exhibition-scene="${source.id}"]`);
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
                setResult({
                  exhibition,
                  sceneIndex,
                  attempt,
                  message,
                  failed: false,
                });
            },
            beginNavigationEvent,
            "Click or tap the scene to enable audio",
            (root) => {
              if (rooms.has(root)) syncRooms();
              else fps.refreshWalkObstacles();
            },
            nonBlockingIds,
          );
          playback.begin();
          onPlaybackReady(true);
        }
        fps.engage();
        setResult({
          exhibition,
          sceneIndex,
          attempt,

          message: "Exhibition ready",
          failed: false,
        });
      }
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        failed = true;
        entrances.dispose();
        appearances.dispose();
        models.dispose();
        waitingForMedia.clear();
        renderer.setAnimationLoop(null);
        disposeModels(scene);
        scene.clear();
        setResult({
          exhibition,
          sceneIndex,
          attempt,

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
      preview?.removeEventListener("exhibit-modal", modalInput);
      document.removeEventListener("visibilitychange", visibilityChanged);
      onPlaybackReady(false);
      playback?.dispose();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", click);
      renderer.domElement.removeEventListener("lostpointercapture", cancelPress);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", cancelPress);
      document.removeEventListener("pointercancel", cancelPress);
      document.removeEventListener("pointerlockchange", cancelPress);
      document.removeEventListener("visibilitychange", cancelPress);
      window.removeEventListener("blur", cancelPress);
      size.disconnect();
      renderer.setAnimationLoop(null);
      fps.dispose();
      if (hotspotTemplate) disposeHotspotSprite(hotspotTemplate);
      entrances.dispose();
      appearances.dispose();
      models.dispose();
      disposeModels(scene);
      scene.clear();
      renderer.domElement.remove();
      if (failed) graphics.resetRenderer();
      selectView.current = () => {};
    };
  }, [
    exhibition,
    graphics,
    sceneIndex,
    entryView,
    attempt,
    navigate,
    beginNavigationEvent,
    onPlaybackReady,
  ]);
  useEffect(() => {
    if (viewpoint && viewpoint !== entryView) selectView.current(viewpoint.id);
  }, [viewpoint, entryView]);
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
        style={{
          visibility: current && !current.failed ? "visible" : "hidden",
        }}
      />
    </section>
  );
}
