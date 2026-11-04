import { createActiveClock } from "./active-clock";
import { moveAttachedObjects } from "../../shared/project/attached-transforms";
import type { ContentScene } from "../../shared/project/project-content";
import { getStartingCamera } from "../../shared/project/starting-view";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ModelCache, disposeModels, type ModelLease } from "../../shared/asset-runtime/ModelCache";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { HOTSPOT_ASSET_ID } from "../../shared/asset-runtime/hotspot";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type {
  CameraPose,
  ProjectScene,
  QuaternionTuple,
  Transform,
} from "../../shared/project/project-types";
import { FpsControls, type FpsMobileControls } from "../controls/fpsControls";
export type { FpsMobileControls } from "../controls/fpsControls";
import { ModeManager } from "./modeManager";
import {
  axisRotation,
  beginAxisRotation,
  beginFreeRotation,
  freeRotation,
  type AxisRotation,
  type FreeRotation,
} from "./rotation";
import { scaleBy, wheelScaleFactor } from "./scaling";
import { axisDragPosition, beginAxisDrag } from "./translation";

//because of the mouse drag delay
const WHEEL_COMMIT_DELAY_MS = 250;

const ROTATION_SNAP = THREE.MathUtils.degToRad(15);

// How far scrolling can push a carried object away, and how close it can pull it in
const CARRY_REACH = 6;
const CARRY_NEAR = 1;
// Metres the aim must travel before a held click starts carrying, like a drag threshold
const CARRY_DEAD_ZONE = 0.05;
const MOBILE_GIZMO_HIT_RADIUS = 32;
// Pointer travel under this many pixels still counts as a click while visiting
const VISITOR_CLICK_TOLERANCE = 6;

const HOTSPOT_SIZE = 0.6;

// One lazy renderer-module owner per editor page, shared across viewport retries/remounts
export const editorModelCache = new ModelCache();
if (import.meta.hot) {
  import.meta.hot.dispose(() => editorModelCache.invalidate());
}

export type ViewportStatus = "loading" | "ready" | "error" | "download-error" | "unsupported";

export interface FpsMeter {
  tick(now: number): void;
}

// What left drag does in the editor view
export type NavigationTool = "select" | "orbit" | "pan" | "zoom";

const leftDrag: Record<NavigationTool, THREE.MOUSE> = {
  select: THREE.MOUSE.ROTATE,
  orbit: THREE.MOUSE.ROTATE,
  pan: THREE.MOUSE.PAN,
  zoom: THREE.MOUSE.DOLLY,
};
const cursors: Record<NavigationTool, string> = {
  select: "",
  orbit: "grab",
  pan: "move",
  zoom: "zoom-in",
};

export interface InitSceneHandle {
  update: (
    nextObjects: readonly SceneObject[],
    nextSelectedId: string | null,
    nextScene?: ProjectScene | null,
    loadGeneration?: number,
  ) => void;
  getDropPosition: (clientX: number, clientY: number) => Vector3Tuple | undefined;
  showDropPosition: (position: Vector3Tuple | undefined) => void;
  pickObjectAt: (clientX: number, clientY: number) => string | undefined;
  worldToLocal: (objectId: string, position: Vector3Tuple) => Vector3Tuple | undefined;
  setEditingEnabled: (enabled: boolean) => void;
  captureCamera: () => CameraPose;
  showCamera: (pose: CameraPose) => void;
  locateObject: (id: string) => void;
  setNavigationTool: (tool: NavigationTool) => void;
  mobileControls: FpsMobileControls;
  modeManager: ModeManager;
  dispose: () => void;
}

export function initScene(
  host: HTMLDivElement,
  assets: readonly CatalogueAsset[],
  callbacks: {
    onStatus: (status: ViewportStatus) => void;
    onThumbnail: (id: string, url: string) => void;
    onSelect: (id: string | null) => void;
    onTransform: (id: string, transform: Transform) => void;
    onObjectClick: (id: string) => void;
    onUpdate: (deltaSeconds: number) => void;
  },
  modelCache: ModelCache = editorModelCache,
): InitSceneHandle | undefined {
  let renderer: THREE.WebGLRenderer;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (context === null) {
      callbacks.onStatus("unsupported");
      return;
    }
    renderer = new THREE.WebGLRenderer({ canvas, context });
  } catch {
    callbacks.onStatus("unsupported");
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9ece7);
  scene.fog = new THREE.Fog(0xe9ece7, 35, 70);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(12, 16, 18);
  camera.lookAt(0, 0, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "3D scene");
  host.appendChild(renderer.domElement);

  let orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.target.set(0, 0, 0);
  let navigationTool: NavigationTool = "select";
  // Select still orbit when you drag empty space. First person has no camera tools
  function applyNavigationTool() {
    orbit.mouseButtons.LEFT = leftDrag[navigationTool];
    renderer.domElement.style.cursor = modeManager.usesOrbit() ? cursors[navigationTool] : "";
  }
  function cameraToolActive() {
    return modeManager.usesOrbit() && navigationTool !== "select";
  }

  const fpsControls = new FpsControls(camera, renderer.domElement);
  const modeManager = new ModeManager(camera, orbit, fpsControls);
  const fpsMeter = createFpsMeter(host);

  const ambient = new THREE.AmbientLight(0xffffff, 1.4);
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(3, 5, 4);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-3, 1, -3);
  scene.add(ambient, sun, fill);
  const grid = new THREE.GridHelper(40, 40, 0xaeb8aa, 0xcdd4c8);
  grid.position.y = -0.01;
  scene.add(grid);

  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x187c6b);
  selection.visible = false;
  scene.add(selection);
  const gizmo = new THREE.Group();
  gizmo.visible = false;
  scene.add(gizmo);
  const handles = [
    { axis: new THREE.Vector3(1, 0, 0), color: 0xc84637 },
    { axis: new THREE.Vector3(0, 1, 0), color: 0x187c6b },
    { axis: new THREE.Vector3(0, 0, 1), color: 0x365fba },
  ].map(({ axis, color }) => {
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), axis]),
      new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false }),
    );
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), material);
    line.renderOrder = 1000;
    tip.renderOrder = 1000;
    gizmo.add(line, tip);
    return { axis, line, tip, length: 0, visible: false };
  });
  const dropMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.61, 40),
    new THREE.MeshBasicMaterial({ color: 0xb64b32, side: THREE.DoubleSide }),
  );
  dropMarker.rotation.x = -Math.PI / 2;
  dropMarker.visible = false;
  scene.add(dropMarker);

  const controller = new AbortController();
  let disposed = false;
  const models = new Map<string, THREE.Group>();
  const leases: ModelLease[] = [];
  const hotspotMaterials = new Set<THREE.SpriteMaterial>();
  let ready = false;
  let editingEnabled = true;
  let objects: readonly SceneObject[] = [];
  let selectedId: string | null = null;
  let projectScene: ProjectScene | null = null;
  let appliedCamera: CameraPose | null = null;
  let appliedLoadGeneration: number | undefined;
  let previewOrigin:
    { sceneId: string | undefined; loadGeneration: number | undefined } | undefined;
  let pendingPreviewReturn: typeof previewOrigin;
  let environment: THREE.Group | undefined;
  let environmentId: string | undefined;
  const environmentBounds = new THREE.Box3();
  const instances = new Map<string, THREE.Group>();
  const instanceAssets = new Map<string, string>();
  function instanceFor(objectId: string): THREE.Group | undefined {
    const exact = instances.get(objectId);
    if (exact !== undefined) return exact;
    const key = objectId.toLowerCase();
    for (const [id, instance] of instances) {
      if (id.toLowerCase() === key) return instance;
    }
    return undefined;
  }
  const hotspotSprites = new Map<string, THREE.Sprite>();
  const bounds = new Map<string, THREE.Box3>();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag:
    | ({
        id: string;
        pointerId: number;
        transform: Transform;
        current: Transform;
      } & (
        | { currentMode: "move"; geometry: NonNullable<ReturnType<typeof beginAxisDrag>> }
        | { currentMode: "rotate"; geometry: AxisRotation }
        | { currentMode: "freeRotate"; geometry: FreeRotation }
        | {
            currentMode: "carry";
            geometry: {
              distance: number;
              offset: THREE.Vector3;
              moving: boolean;
              // Touch carries under the finger, the mouse under the crosshair
              finger: { x: number; y: number } | undefined;
            };
          }
      ))
    | undefined;
  let orbitEnabledBeforeDrag = true;
  // Drags begun with the mouse locked stop when it is freed, the pointer would jump otherwise
  let dragLocked = false;
  // Scroll that is shown but not yet saved.
  let wheelEdit:
    { id: string; transform: Transform; current: Transform; timer: number } | undefined;
  let previewFrame: number | undefined;
  let pendingPreview: { id: string; transform: Transform } | undefined;
  const touchPoints = new Map<number, { x: number; y: number }>();
  let touchPair:
    | {
        pointerIds: readonly number[];
        startDistance: number;
        startAngle: number;
      }
    | undefined;
  let touchGesture:
    | {
        id: string;
        pointerIds: readonly number[];
        // The document's transform, a drag handed over to the gesture may have moved past it
        original: Transform;
        transform: Transform;
        current: Transform;
        mode: "scale" | "rotate";
        startDistance: number;
        startAngle: number;
        rotationAxis: THREE.Vector3;
      }
    | undefined;
  // A press stays tied to the object under it; once it becomes a drag it can no longer click
  // A locked mouse stays where capture began, so it counts relative movement instead
  let visitorClick:
    | {
        pointerId: number;
        x: number;
        y: number;
        moved: { x: number; y: number };
        target: string | null;
        dragged: boolean;
      }
    | undefined;

  function render() {
    if (!disposed) {
      renderer.render(scene, camera);
    }
  }

  function resize() {
    if (disposed) {
      return;
    }
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    updateGizmo();
    render();
  }
  const observer = new ResizeObserver(resize);

  function projectedPoint(point: THREE.Vector3) {
    const rect = renderer.domElement.getBoundingClientRect();
    const projected = point.clone().project(camera);
    return {
      x: rect.left + ((projected.x + 1) * rect.width) / 2,
      y: rect.top + ((1 - projected.y) * rect.height) / 2,
    };
  }

  function updateGizmo() {
    // The transform gizmo is an editor tool; hide it while exploring as a visitor
    if (modeManager.getState().mode !== "editor") {
      gizmo.visible = false;
      return;
    }
    const instance = selectedId === null ? undefined : instances.get(selectedId);
    gizmo.visible = instance !== undefined;
    if (instance === undefined) return;
    gizmo.position.copy(instance.position);
    camera.updateMatrixWorld(true);
    const pivot = instance.position;
    const distance = THREE.MathUtils.clamp(camera.position.distanceTo(pivot), 0.25, 1000);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    if (pivot.clone().sub(camera.position).dot(forward) <= camera.near) {
      gizmo.visible = false;
      return;
    }
    const pixelScale = THREE.MathUtils.clamp(
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
        Math.max(renderer.domElement.clientHeight, 1),
      0.0001,
      100,
    );
    const start = projectedPoint(pivot);
    for (const handle of handles) {
      const trial = projectedPoint(pivot.clone().addScaledVector(handle.axis, 80 * pixelScale));
      const projectedLength = Math.hypot(trial.x - start.x, trial.y - start.y);
      handle.visible = projectedLength >= 12;
      handle.line.visible = handle.visible;
      handle.tip.visible = handle.visible;
      if (!handle.visible) continue;
      handle.length = (80 * pixelScale * 80) / projectedLength;
      handle.line.scale.setScalar(handle.length);
      handle.tip.position.copy(handle.axis).multiplyScalar(handle.length);
      handle.tip.scale.setScalar(6 * pixelScale);
    }
  }

  function pickHandle(clientX: number, clientY: number, hitRadius = 10) {
    if (!gizmo.visible) return;
    const pivot = projectedPoint(gizmo.position);
    let nearest = hitRadius;
    let picked: (typeof handles)[number] | undefined;
    for (const handle of handles) {
      if (!handle.visible) continue;
      const end = projectedPoint(
        gizmo.position.clone().addScaledVector(handle.axis, handle.length),
      );
      const dx = end.x - pivot.x;
      const dy = end.y - pivot.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared < 20 * 20) continue;
      const t = Math.max(
        12 / Math.sqrt(lengthSquared),
        Math.min(1, ((clientX - pivot.x) * dx + (clientY - pivot.y) * dy) / lengthSquared),
      );
      const distance = Math.hypot(clientX - pivot.x - t * dx, clientY - pivot.y - t * dy);
      if (distance < nearest) {
        nearest = distance;
        picked = handle;
      }
    }
    return picked;
  }

  const gizmoCameraPosition = new THREE.Vector3();
  const gizmoCameraQuaternion = new THREE.Quaternion();
  // Orbit reports its own changes, walking and looking around dont
  function refreshGizmoForWalking() {
    if (modeManager.usesOrbit()) return;
    if (
      gizmoCameraPosition.equals(camera.position) &&
      gizmoCameraQuaternion.equals(camera.quaternion)
    )
      return;
    gizmoCameraPosition.copy(camera.position);
    gizmoCameraQuaternion.copy(camera.quaternion);
    updateGizmo();
  }

  function syncHotspots() {
    const editorMode = modeManager.getState().mode === "editor";
    const current = new Set<string>();
    for (const hotspot of projectScene?.hotspots ?? []) {
      current.add(hotspot.id);
      const owner = instanceFor(hotspot.objectId);
      if (owner === undefined) continue;
      let sprite = hotspotSprites.get(hotspot.id);
      if (sprite === undefined) {
        const source = models.get(HOTSPOT_ASSET_ID)?.children[0];
        if (!(source instanceof THREE.Sprite)) continue;
        sprite = source.clone();
        hotspotSprites.set(hotspot.id, sprite);
      }
      if (sprite.parent !== owner) owner.add(sprite);
      const [x, y, z] = hotspot.position;
      sprite.position.set(x, y + HOTSPOT_SIZE / 2, z);
      sprite.visible = editorMode;
    }
    for (const [id, sprite] of hotspotSprites) {
      if (!current.has(id)) {
        sprite.parent?.remove(sprite);
        hotspotSprites.delete(id);
      }
    }
  }

  let lastFrameTime = performance.now();
  const interactionClock = createActiveClock(lastFrameTime, false);
  const visibilityChanged = () => {
    const now = performance.now();
    interactionClock.setActive(now, !document.hidden && modeManager.getState().mode === "visitor");
    lastFrameTime = now;
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  const animate = (now: number) => {
    if (disposed) {
      return;
    }
    requestAnimationFrame(animate);
    const delta = document.hidden ? 0 : Math.min(Math.max(0, now - lastFrameTime) / 1000, 0.1);
    const elapsed = interactionClock.tick(now);
    lastFrameTime = now;
    modeManager.update(delta);
    // Walking moves a carried object too, not only the mouse
    carry();
    refreshGizmoForWalking();
    if (modeManager.getState().mode === "visitor") callbacks.onUpdate(elapsed);
    fpsMeter.tick(now);
    render();
  };
  requestAnimationFrame(animate);

  function showCamera(pose: import("../../shared/project/project-types").CameraPose) {
    if (modeManager.getState().mode === "visitor") {
      camera.position.fromArray(pose.position);
      camera.quaternion.fromArray(pose.rotation);
      camera.fov = pose.fovDegrees;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      fpsControls.syncFromCamera();
      return;
    }
    camera.position.fromArray(pose.position);
    camera.quaternion.fromArray(pose.rotation);
    // Keep upright views orbiting around world Y, while preserving authored roll
    const authoredUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    camera.up.set(0, 1, 0).projectOnPlane(right).normalize();
    const alignment = camera.up.dot(authoredUp);
    if (Math.abs(alignment) < 1e-6) camera.up.copy(authoredUp);
    else if (alignment < 0) camera.up.negate();
    // OrbitControls captures its up axis at construction; replace it for rolled or vertical poses
    // This also drops the old view's pointer state and damping
    orbit.removeEventListener("change", updateGizmo);
    orbit.dispose();
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.enabled = editingEnabled && modeManager.usesOrbit();
    applyNavigationTool();
    // The constructor looks at its default target, so reinstall the authored pose afterward
    camera.position.fromArray(pose.position);
    camera.quaternion.fromArray(pose.rotation);
    orbit.target
      .copy(camera.position)
      .addScaledVector(
        camera.getWorldDirection(new THREE.Vector3()),
        Math.max(camera.position.length(), 1),
      );
    modeManager.setOrbitControls(orbit);
    orbit.addEventListener("change", updateGizmo);
    camera.fov = pose.fovDegrees;
    camera.updateProjectionMatrix();
    modeManager.resetView();
    camera.updateMatrixWorld(true);
  }

  function update(
    nextObjects: readonly SceneObject[],
    nextSelectedId: string | null,
    nextScene: ProjectScene | null = projectScene,
    loadGeneration = appliedLoadGeneration ?? 0,
  ) {
    if (
      drag !== undefined &&
      (nextSelectedId !== drag.id ||
        nextObjects.find((object) => object.id === drag?.id)?.transform !== drag.transform)
    ) {
      cancelDrag();
    }
    if (
      touchGesture !== undefined &&
      (nextSelectedId !== touchGesture.id ||
        nextObjects.find((object) => object.id === touchGesture?.id)?.transform !==
          touchGesture.original)
    ) {
      cancelTouchGesture();
    }
    if (
      wheelEdit !== undefined &&
      nextObjects.find((object) => object.id === wheelEdit?.id)?.transform !== wheelEdit.transform
    ) {
      // Undo or another edit replaced the object mid-scroll; drop the unsaved scale
      cancelWheelEdit();
    }
    const sceneChanged = projectScene?.id !== nextScene?.id;
    const loadChanged = appliedLoadGeneration !== loadGeneration;
    // A load that arrives together with a new selection keeps the live camera
    // An explicit load always restores the saved camera, even when it also clears the selection
    const reloadCamera = loadChanged;
    objects = nextObjects;
    selectedId = nextSelectedId;
    projectScene = nextScene;
    // A loaded camera resets the view once
    // Selection and placement keep the same camera-pose reference
    const startingCamera = projectScene ? getStartingCamera(projectScene) : null;
    // Renaming a view can produce a fresh object with the same pose. Keep the live camera still.
    // Loading leaves Preview. Scene navigation keeps the same visitor controls and asset cache
    if (startingCamera !== null && loadChanged) modeManager.setMode("editor");
    if (
      startingCamera !== null &&
      (sceneChanged ||
        reloadCamera ||
        JSON.stringify(appliedCamera) !== JSON.stringify(startingCamera))
    ) {
      if (sceneChanged)
        interactionClock.reset(
          performance.now(),
          modeManager.getState().mode === "visitor" && !document.hidden,
        );
      appliedCamera = startingCamera;
      // ModeManager already restored the editing pose. Returning to the preview's
      // origin must not replace it with that scene's starting view.
      const returningFromPreview =
        pendingPreviewReturn !== undefined &&
        pendingPreviewReturn.sceneId === projectScene?.id &&
        pendingPreviewReturn.loadGeneration === loadGeneration;
      if (!returningFromPreview) showCamera(appliedCamera);
    }
    // Consume only on a scene/load transition, not a redundant update before return.
    if (sceneChanged || loadChanged) pendingPreviewReturn = undefined;
    appliedLoadGeneration = loadGeneration;

    if (ready && environmentId !== (projectScene?.environmentAssetId ?? undefined)) {
      // Environment stays at its exported origin, outside the placed-object list
      // Removed instances borrow resources from this viewport's cache leases
      if (environment !== undefined) scene.remove(environment);
      environmentId = projectScene?.environmentAssetId ?? undefined;
      environment =
        environmentId === undefined ? undefined : models.get(environmentId)?.clone(true);
      environmentBounds.makeEmpty();
      if (environment !== undefined) {
        scene.add(environment);
        environmentBounds.setFromObject(environment);
      }
    }
    // Sample room floor sits at zero; lift the grid slightly so it stays readable
    grid.position.y = projectScene === null ? -0.01 : 0.01;
    for (const [id, instance] of instances) {
      if (
        !objects.some((object) => object.id === id && object.assetId === instanceAssets.get(id))
      ) {
        // An imported project can reuse an ID with a different model
        scene.remove(instance);
        instances.delete(id);
        instanceAssets.delete(id);
        bounds.delete(id);
      }
    }
    if (ready) {
      for (const object of objects) {
        const model = models.get(object.assetId);
        if (model === undefined) {
          continue;
        }
        let instance = instances.get(object.id);
        if (instance === undefined) {
          instance = new THREE.Group();
          // Clone nodes for independent transforms; cache leases own geometry/materials/textures
          instance.add(model.clone(true));
          instances.set(object.id, instance);
          instanceAssets.set(object.id, object.assetId);
          scene.add(instance);
        }
        instance.position.fromArray(object.transform.position);
        instance.quaternion.fromArray(object.transform.rotation);
        instance.scale.fromArray(object.transform.scale);
        // Bounds read the parent's world matrix, which must reflect this frame's transform.
        instance.updateMatrixWorld(true);
        // Exclude attached markers so selection outlines match the model itself.
        const content = instance.children.find((child) => !(child instanceof THREE.Sprite));
        bounds.set(
          object.id,
          new THREE.Box3().setFromObject(content === undefined ? instance : content),
        );
      }
      syncHotspots();
    }
    const selectedBounds = getSelectionBounds();
    selection.visible = selectedBounds !== undefined && modeManager.getState().mode === "editor";
    if (selectedBounds !== undefined) {
      selection.box.copy(selectedBounds);
    }
    updateGizmo();
    render();
  }

  function getSelectionBounds() {
    // Use the same outline for the room and exhibits
    // Room bounds stay separate from the movable object instances
    if (selectedId === projectScene?.id && !environmentBounds.isEmpty()) {
      return environmentBounds;
    }
    return selectedId === null ? undefined : bounds.get(selectedId);
  }

  // A locked mouse doesnt move on screen, so it aims with the crosshair in the middle
  function aimPoint(event: MouseEvent) {
    if (!fpsControls.isCaptured()) return { x: event.clientX, y: event.clientY };
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function screenRay(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
      0.5,
    );
    return new THREE.Ray(camera.position, point.unproject(camera).sub(camera.position).normalize());
  }

  function getDropPosition(clientX: number, clientY: number): Vector3Tuple | undefined {
    if (!ready || !editingEnabled || modeManager.getState().mode !== "editor") {
      return;
    }
    const point = screenRay(clientX, clientY).intersectPlane(ground, new THREE.Vector3());
    if (
      point === null ||
      !point.toArray().every((value) => Number.isFinite(value) && Math.abs(value) <= 20)
    ) {
      return;
    }
    return [point.x, 0, point.z];
  }

  function showDropPosition(position: Vector3Tuple | undefined) {
    dropMarker.visible = position !== undefined;
    if (position !== undefined) {
      dropMarker.position.set(position[0], 0.02, position[2]);
    }
    render();
  }

  function applyPreviewTransform(id: string, transform: Transform) {
    const instance = instances.get(id);
    if (instance === undefined) return;
    // Preview uses the same attachment delta as commit so cancel restores every child too
    const moved = moveAttachedObjects(
      objects,
      (projectScene as ContentScene | null)?.groups ?? [],
      id,
      transform,
    );
    if (!moved.ok) return;
    for (const object of moved.value) {
      const child = instances.get(object.id);
      if (child) {
        applyTransform(child, object.transform);
        bounds.set(object.id, new THREE.Box3().setFromObject(child));
      }
    }
    const box = new THREE.Box3().setFromObject(instance);
    bounds.set(id, box);
    selection.box.copy(box);
    updateGizmo();
    render();
  }

  function previewTransform(id: string, transform: Transform, immediate = false) {
    pendingPreview = { id, transform };
    if (immediate) {
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      previewFrame = undefined;
      const next = pendingPreview;
      pendingPreview = undefined;
      applyPreviewTransform(next.id, next.transform);
      return;
    }
    if (previewFrame !== undefined) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = undefined;
      const next = pendingPreview;
      pendingPreview = undefined;
      if (next !== undefined) applyPreviewTransform(next.id, next.transform);
    });
  }

  // A drag handing over to a two-finger gesture keeps the capture. Releasing it would report
  // that finger as lost, and that ends the gesture it is now part of
  function cancelDrag(keepCapture = false) {
    if (drag === undefined) return;
    const previous = drag;
    drag = undefined;
    orbit.enabled = orbitEnabledBeforeDrag;
    fpsControls.holdLook(false);
    previewTransform(previous.id, previous.transform, true);
    if (!keepCapture && renderer.domElement.hasPointerCapture(previous.pointerId)) {
      renderer.domElement.releasePointerCapture(previous.pointerId);
    }
  }

  // Two-finger transforms belong to authoring, not to Preview or the camera tools
  function touchEditingAllowed() {
    return modeManager.getState().mode === "editor" && !cameraToolActive();
  }

  function cancelTouchGesture() {
    touchPair = undefined;
    if (touchGesture === undefined) return;
    const previous = touchGesture;
    touchGesture = undefined;
    orbit.enabled = orbitEnabledBeforeDrag;
    previewTransform(previous.id, previous.original, true);
  }

  function cancelWheelEdit() {
    if (wheelEdit === undefined) return;
    const previous = wheelEdit;
    wheelEdit = undefined;
    clearTimeout(previous.timer);
    previewTransform(previous.id, previous.transform);
  }

  function commitWheelEdit() {
    if (wheelEdit === undefined) return;
    const completed = wheelEdit;
    wheelEdit = undefined;
    clearTimeout(completed.timer);
    previewTransform(completed.id, completed.current, true);
    callbacks.onTransform(completed.id, completed.current);
  }

  function beginDrag(event: PointerEvent, next: NonNullable<typeof drag>) {
    //disable to stop camera
    orbitEnabledBeforeDrag = orbit.enabled;
    orbit.enabled = false;
    drag = next;
    dragLocked = fpsControls.isCaptured();
    // A locked mouse already sends every event to the canvas, and capturing it then throws
    if (!dragLocked) renderer.domElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  // The point straight ahead of the crosshair, this far from the eye
  function carryAim(distance: number, finger?: { x: number; y: number }) {
    const direction =
      finger === undefined
        ? camera.getWorldDirection(new THREE.Vector3())
        : screenRay(finger.x, finger.y).direction;
    return camera.position.clone().addScaledVector(direction, distance);
  }

  // First person: holding the click on an object picks it up, letting go puts it down
  function startCarry(event: PointerEvent, id: string | null) {
    const object = objects.find((entry) => entry.id === id);
    const instance = id === null ? undefined : instances.get(id);
    if (object === undefined || instance === undefined) return;
    const aim = aimPoint(event);
    const ray = screenRay(aim.x, aim.y);
    const hit = new THREE.Raycaster(ray.origin, ray.direction).intersectObject(instance, true)[0];
    if (hit === undefined) return;
    const finger = event.pointerType === "touch" ? aim : undefined;
    beginDrag(event, {
      id: object.id,
      pointerId: event.pointerId,
      transform: object.transform,
      current: object.transform,
      currentMode: "carry",
      // Keep the grab point under the crosshair so the object doesnt jump on pick up
      geometry: {
        distance: hit.distance,
        offset: new THREE.Vector3()
          .fromArray(object.transform.position)
          .sub(carryAim(hit.distance, finger)),
        moving: false,
        finger,
      },
    });
  }

  // First person: holding right click on an object turns it, the camera stays still meanwhile
  function startTurn(event: PointerEvent, id: string | null) {
    const object = objects.find((entry) => entry.id === id);
    if (object === undefined) return;
    const rotation = new THREE.Quaternion().fromArray(object.transform.rotation);
    beginDrag(event, {
      id: object.id,
      pointerId: event.pointerId,
      transform: object.transform,
      current: object.transform,
      currentMode: "freeRotate",
      geometry: beginFreeRotation(rotation, 0, 0),
    });
    fpsControls.holdLook(true);
  }

  function carry() {
    const held = drag;
    if (held?.currentMode !== "carry") return;
    const position = carryAim(held.geometry.distance, held.geometry.finger).add(
      held.geometry.offset,
    );
    // Objects stand on the floor, so looking down lowers it only that far
    position.y = Math.max(position.y, 0);
    // Clicking while still gliding to a stop stay a plain select, not an undo step
    const start = new THREE.Vector3().fromArray(held.transform.position);
    if (!held.geometry.moving && position.distanceTo(start) < CARRY_DEAD_ZONE) return;
    held.geometry.moving = true;
    if (position.toArray().every((value, index) => value === held.current.position[index])) return;
    held.current = { ...held.current, position: position.toArray() as Vector3Tuple };
    previewTransform(held.id, held.current);
  }

  function startRotation(event: PointerEvent, handle: (typeof handles)[number] | undefined) {
    const object = objects.find((entry) => entry.id === selectedId);
    const instance = selectedId === null ? undefined : instances.get(selectedId);
    if (object === undefined || instance === undefined) return;
    const ray = screenRay(event.clientX, event.clientY);
    const rotation = new THREE.Quaternion().fromArray(object.transform.rotation);
    const shared = {
      id: object.id,
      pointerId: event.pointerId,
      transform: object.transform,
      current: object.transform,
    };
    if (handle !== undefined) {
      const geometry = beginAxisRotation(
        ray,
        camera.position,
        new THREE.Vector3().fromArray(object.transform.position),
        handle.axis,
        rotation,
        event.clientX,
      );
      beginDrag(event, { ...shared, currentMode: "rotate", geometry });
      return;
    }
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    if (raycaster.intersectObject(instance, true).length === 0) return;
    const geometry = beginFreeRotation(rotation, event.clientX, event.clientY);
    beginDrag(event, { ...shared, currentMode: "freeRotate", geometry });
  }

  function pick(clientX: number, clientY: number) {
    const ray = screenRay(clientX, clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    let nearest =
      environment === undefined
        ? Infinity
        : (raycaster.intersectObject(environment, true)[0]?.distance ?? Infinity);
    // A wall or floor hit selects the room; a closer exhibit can still win the pick
    let id: string | null = Number.isFinite(nearest) ? (projectScene?.id ?? null) : null;
    for (const [objectId, instance] of instances) {
      const hit = raycaster.intersectObject(instance, true)[0];
      if (hit !== undefined && hit.distance < nearest) {
        nearest = hit.distance;
        id = objectId;
      }
    }
    return id;
  }

  function pickObjectAt(clientX: number, clientY: number): string | undefined {
    const ray = screenRay(clientX, clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    let nearest = Infinity;
    let id: string | undefined;
    for (const [objectId, instance] of instances) {
      const hit = raycaster.intersectObject(instance, true)[0];
      if (hit !== undefined && hit.distance < nearest) {
        nearest = hit.distance;
        id = objectId;
      }
    }
    return id;
  }

  function worldToLocal(objectId: string, position: Vector3Tuple): Vector3Tuple | undefined {
    const instance = instances.get(objectId);
    if (instance === undefined) return;
    instance.updateWorldMatrix(true, false);
    return instance.worldToLocal(new THREE.Vector3().fromArray(position)).toArray() as Vector3Tuple;
  }

  function pointerDown(event: PointerEvent) {
    if (!ready) return;
    if (event.pointerType === "touch") {
      touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    // A finger already on a joystick is the primary touch, so count the ones on the scene instead
    const firstContact = event.pointerType === "touch" ? touchPoints.size === 1 : event.isPrimary;
    if (modeManager.getState().mode === "visitor") {
      const aim = aimPoint(event);
      visitorClick =
        firstContact && event.button === 0
          ? {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              moved: { x: 0, y: 0 },
              target: pick(aim.x, aim.y),
              dragged: false,
            }
          : undefined;
      return;
    }
    if (!editingEnabled || (event.button !== 0 && event.button !== 2)) return;
    if (event.pointerType === "touch" && touchPoints.size === 2) {
      if (!touchEditingAllowed()) return;
      const points = [...touchPoints.values()];
      const dx = points[1]!.x - points[0]!.x;
      const dy = points[1]!.y - points[0]!.y;
      touchPair = {
        pointerIds: [...touchPoints.keys()],
        startDistance: Math.max(Math.hypot(dx, dy), 1),
        startAngle: Math.atan2(dy, dx),
      };
      return;
    }
    if (!firstContact || drag !== undefined || touchGesture !== undefined) return;
    // Camera tools never pick or move objects
    if (cameraToolActive()) return;
    // First person: a plain click only grab the mouse, FpsControls does that
    if (fpsControls.wantsCapture(event)) return;
    if (wheelEdit !== undefined) {
      commitWheelEdit();
      event.preventDefault();
      return;
    }
    // With the mouse locked, clicking picks what the crosshair is on.
    // Holding the left button carries the object; holding right turns it.
    if (fpsControls.isCaptured()) {
      const aim = aimPoint(event);
      const id = pick(aim.x, aim.y);
      callbacks.onSelect(id);
      if (event.button === 0) startCarry(event, id);
      else startTurn(event, id);
      return;
    }
    // Touch never locks the pointer. In first person a finger on an object moves it freely,
    // so the gizmo only answers presses that miss the object
    if (event.pointerType === "touch" && fpsControls.isEngaged()) {
      const id = pick(event.clientX, event.clientY);
      if (objects.some((object) => object.id === id)) {
        callbacks.onSelect(id);
        startCarry(event, id);
        return;
      }
    }
    const handle = pickHandle(
      event.clientX,
      event.clientY,
      event.pointerType === "touch" ? MOBILE_GIZMO_HIT_RADIUS : 10,
    );
    if (event.button === 2) {
      startRotation(event, handle);
      return;
    }
    if (handle !== undefined && selectedId !== null) {
      const object = objects.find((entry) => entry.id === selectedId);
      if (object === undefined) return;
      const geometry = beginAxisDrag(
        screenRay(event.clientX, event.clientY),
        camera.position,
        new THREE.Vector3().fromArray(object.transform.position),
        handle.axis,
      );
      if (geometry === undefined) return;
      beginDrag(event, {
        id: object.id,
        pointerId: event.pointerId,
        transform: object.transform,
        current: object.transform,
        currentMode: "move",
        geometry,
      });
      return;
    }
    callbacks.onSelect(pick(event.clientX, event.clientY));
  }

  function pointerMove(event: PointerEvent) {
    if (modeManager.getState().mode === "visitor") {
      const click = visitorClick;
      if (click === undefined || click.pointerId !== event.pointerId) return;
      if (fpsControls.isCaptured()) {
        click.moved.x += event.movementX;
        click.moved.y += event.movementY;
      } else {
        click.moved = { x: event.clientX - click.x, y: event.clientY - click.y };
      }
      if (Math.hypot(click.moved.x, click.moved.y) > VISITOR_CLICK_TOLERANCE) click.dragged = true;
      return;
    }
    if (event.pointerType === "touch" && touchPoints.has(event.pointerId)) {
      touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!touchEditingAllowed()) {
        cancelTouchGesture();
        return;
      }
      if (touchGesture !== undefined) {
        const first = touchPoints.get(touchGesture.pointerIds[0]!);
        const second = touchPoints.get(touchGesture.pointerIds[1]!);
        if (first === undefined || second === undefined) return;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const angle = Math.atan2(dy, dx);
        let rotationDelta = angle - touchGesture.startAngle;
        rotationDelta -= Math.round(rotationDelta / (2 * Math.PI)) * 2 * Math.PI;
        if (touchGesture.mode === "scale") {
          touchGesture.current = {
            ...touchGesture.current,
            scale: scaleBy(touchGesture.transform.scale, distance / touchGesture.startDistance),
          };
        } else {
          const rotation = new THREE.Quaternion()
            .setFromAxisAngle(touchGesture.rotationAxis, rotationDelta)
            .multiply(new THREE.Quaternion().fromArray(touchGesture.transform.rotation))
            .normalize();
          touchGesture.current = {
            ...touchGesture.current,
            rotation: rotation.toArray() as QuaternionTuple,
          };
        }
        previewTransform(touchGesture.id, touchGesture.current);
        return;
      }
      const pairFirst = touchPair && touchPoints.get(touchPair.pointerIds[0]!);
      const pairSecond = touchPair && touchPoints.get(touchPair.pointerIds[1]!);
      if (touchPair !== undefined && pairFirst !== undefined && pairSecond !== undefined) {
        const dx = pairSecond.x - pairFirst.x;
        const dy = pairSecond.y - pairFirst.y;
        // Spread in any direction scales, the angle between the fingers rotates
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const angle = Math.atan2(dy, dx);
        let rotationDelta = angle - touchPair.startAngle;
        rotationDelta -= Math.round(rotationDelta / (2 * Math.PI)) * 2 * Math.PI;
        const scaleIntent = Math.abs(distance - touchPair.startDistance) >= 12;
        const rotationIntent =
          Math.abs(rotationDelta) >= 0.16 && Math.abs(rotationDelta) * distance >= 18;
        if (scaleIntent || rotationIntent) {
          const object = objects.find((entry) => entry.id === selectedId);
          if (object !== undefined) {
            const activeDrag = drag;
            const base = activeDrag?.id === object.id ? activeDrag.current : object.transform;
            if (activeDrag !== undefined) cancelDrag(true);
            // The gesture owns both fingers now, the camera shouldnt pinch along with it
            orbitEnabledBeforeDrag = orbit.enabled;
            orbit.enabled = false;
            const scaleStrength = Math.abs(distance - touchPair.startDistance) / 12;
            const rotationStrength = (Math.abs(rotationDelta) * distance) / 18;
            const diagonalStart = Math.abs(Math.sin(touchPair.startAngle * 2)) >= 0.5;
            const scaleWins =
              scaleIntent &&
              !rotationIntent &&
              (!diagonalStart || scaleStrength >= rotationStrength);
            touchGesture = {
              id: object.id,
              pointerIds: touchPair.pointerIds,
              original: object.transform,
              transform: base,
              current: base,
              mode: scaleWins ? "scale" : "rotate",
              startDistance: distance,
              startAngle: angle,
              rotationAxis: camera.getWorldDirection(new THREE.Vector3()).normalize(),
            };
            touchPair = undefined;
            event.preventDefault();
          }
        }
      }
      if (touchGesture !== undefined) return;
      if (touchPair !== undefined && event.pointerId !== drag?.pointerId) return;
    }
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    if (drag.currentMode === "carry") {
      if (drag.geometry.finger !== undefined) {
        drag.geometry.finger = { x: event.clientX, y: event.clientY };
      }
      carry();
      return;
    }
    const ray = screenRay(event.clientX, event.clientY);
    if (drag.currentMode === "move") {
      const position = axisDragPosition(drag.geometry, ray);
      if (position === undefined) return;
      drag.current = { ...drag.current, position: position.toArray() as Vector3Tuple };
    } else if (drag.currentMode === "freeRotate" && dragLocked) {
      // A locked mouse stays put on screen, so add up how far it moved instead
      const { lastX, lastY } = drag.geometry;
      const rotation = freeRotation(
        drag.geometry,
        lastX + event.movementX,
        lastY + event.movementY,
        camera.quaternion,
      );
      drag.current = { ...drag.current, rotation: rotation.toArray() as QuaternionTuple };
    } else {
      const rotation =
        drag.currentMode === "rotate"
          ? axisRotation(drag.geometry, ray, event.clientX, event.shiftKey ? ROTATION_SNAP : 0)
          : freeRotation(drag.geometry, event.clientX, event.clientY, camera.quaternion);
      if (rotation === undefined) return;
      drag.current = { ...drag.current, rotation: rotation.toArray() as QuaternionTuple };
    }
    previewTransform(drag.id, drag.current);
  }

  function pointerUp(event: PointerEvent) {
    if (event.pointerType === "touch") {
      touchPoints.delete(event.pointerId);
      if (touchGesture?.pointerIds.includes(event.pointerId)) {
        const completed = touchGesture;
        touchGesture = undefined;
        orbit.enabled = orbitEnabledBeforeDrag;
        previewTransform(completed.id, completed.current, true);
        if (completed.current !== completed.original) {
          callbacks.onTransform(completed.id, completed.current);
        }
        return;
      }
      if (touchPair?.pointerIds.includes(event.pointerId)) touchPair = undefined;
    }
    if (modeManager.getState().mode === "visitor") {
      const click = visitorClick;
      visitorClick = undefined;
      const aim = aimPoint(event);
      if (
        click !== undefined &&
        click.pointerId === event.pointerId &&
        !click.dragged &&
        click.target !== null &&
        pick(aim.x, aim.y) === click.target
      ) {
        callbacks.onObjectClick(click.target);
      }
      return;
    }
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    // Alt or Esc can free the mouse before the browser reports it, so check the lock itself
    if (dragLocked && document.pointerLockElement !== renderer.domElement) {
      cancelDrag();
      return;
    }
    pointerMove(event);
    const completed = drag;
    drag = undefined;
    orbit.enabled = orbitEnabledBeforeDrag;
    fpsControls.holdLook(false);
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
    previewTransform(completed.id, completed.current, true);
    if (completed.current !== completed.transform) {
      callbacks.onTransform(completed.id, completed.current);
    }
  }

  function wheel(event: WheelEvent) {
    if (drag?.currentMode === "carry" && event.deltaY !== 0) {
      event.preventDefault();
      event.stopPropagation();
      // Scrolling while carrying pushes the object away or pulls it closer
      const { distance } = drag.geometry;
      drag.geometry.distance = THREE.MathUtils.clamp(
        distance * wheelScaleFactor(event.deltaY, event.deltaMode),
        Math.min(CARRY_NEAR, distance),
        Math.max(CARRY_REACH, distance),
      );
      carry();
      return;
    }
    if (
      !ready ||
      !editingEnabled ||
      cameraToolActive() ||
      drag !== undefined ||
      selectedId === null ||
      event.deltaY === 0
    )
      return;
    if (modeManager.getState().mode !== "editor") return;
    const object = objects.find((entry) => entry.id === selectedId);
    const instance = instances.get(selectedId);
    if (object === undefined || instance === undefined) return;
    const aim = aimPoint(event);
    const ray = screenRay(aim.x, aim.y);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    if (raycaster.intersectObject(instance, true).length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (wheelEdit !== undefined && wheelEdit.id !== object.id) commitWheelEdit();
    const edit = wheelEdit ?? {
      id: object.id,
      transform: object.transform,
      current: object.transform,
      timer: 0,
    };
    clearTimeout(edit.timer);
    const factor = wheelScaleFactor(event.deltaY, event.deltaMode);
    edit.current = { ...edit.current, scale: scaleBy(edit.current.scale, factor) };
    edit.timer = window.setTimeout(commitWheelEdit, WHEEL_COMMIT_DELAY_MS);
    wheelEdit = edit;
    previewTransform(edit.id, edit.current, true);
  }

  function keyDown(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      (drag === undefined && wheelEdit === undefined && touchGesture === undefined)
    )
      return;
    event.preventDefault();
    cancelDrag();
    cancelTouchGesture();
    cancelWheelEdit();
  }

  // Also runs after every normal lift, touch pointers lose their implicit capture then. So only
  // the fingers an edit actually depends on can cancel it
  function pointerCancel(event: PointerEvent) {
    if (event.pointerType === "touch") {
      touchPoints.delete(event.pointerId);
      if (touchGesture?.pointerIds.includes(event.pointerId)) cancelTouchGesture();
      else if (touchPair?.pointerIds.includes(event.pointerId)) touchPair = undefined;
    }
    if (event.pointerId === visitorClick?.pointerId) visitorClick = undefined;
    if (event.pointerId === drag?.pointerId) cancelDrag();
  }

  function contextMenu(event: MouseEvent) {
    if (modeManager.getState().mode === "editor") event.preventDefault();
  }

  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointercancel", pointerCancel);
  renderer.domElement.addEventListener("lostpointercapture", pointerCancel);
  renderer.domElement.addEventListener("contextmenu", contextMenu);
  host.addEventListener("wheel", wheel, { capture: true, passive: false });
  window.addEventListener("keydown", keyDown);
  orbit.addEventListener("change", updateGizmo);
  let shownCamera = "";
  let previousMode = modeManager.getState().mode;
  const unsubscribeMode = modeManager.subscribe(({ mode, view, captured }) => {
    if (mode !== previousMode) {
      if (mode === "visitor") {
        previewOrigin = { sceneId: projectScene?.id, loadGeneration: appliedLoadGeneration };
        pendingPreviewReturn = undefined;
      } else {
        pendingPreviewReturn =
          previewOrigin?.sceneId !== projectScene?.id ? previewOrigin : undefined;
        previewOrigin = undefined;
      }
      interactionClock.reset(performance.now(), mode === "visitor" && !document.hidden);
      previousMode = mode;
    }
    visitorClick = undefined;
    // Esc or Alt let go of the mouse, which also puts back whatever was being carried or turned
    if (!captured && drag !== undefined && dragLocked) cancelDrag();
    // Grabbing or freeing the mouse alone shouldnt cancel an edit
    if (shownCamera === `${mode} ${view}`) return;
    shownCamera = `${mode} ${view}`;
    cancelDrag();
    cancelTouchGesture();
    cancelWheelEdit();
    // Cancellation must not re-enable orbit controls while visiting or walking
    orbit.enabled = modeManager.usesOrbit() && editingEnabled;
    applyNavigationTool();
    selection.visible = mode === "editor" && getSelectionBounds() !== undefined;
    // Markers are authoring aids; visitors interact with the objects themselves.
    for (const sprite of hotspotSprites.values()) sprite.visible = mode === "editor";
    updateGizmo();
  });
  observer.observe(host);
  resize();

  async function loadAssets() {
    try {
      for (const asset of assets) {
        if (asset.id === HOTSPOT_ASSET_ID) {
          const texture = await new THREE.TextureLoader().loadAsync(asset.url);
          if (disposed || controller.signal.aborted) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
          });
          hotspotMaterials.add(material);
          const sprite = new THREE.Sprite(material);
          sprite.scale.setScalar(HOTSPOT_SIZE);
          sprite.position.y = HOTSPOT_SIZE / 2;
          const model = new THREE.Group();
          model.add(sprite);
          models.set(asset.id, model);
          continue;
        }
        const lease = await modelCache.acquire(asset, controller.signal);
        if (disposed) {
          lease.release();
          return;
        }
        leases.push(lease);
        const { model } = lease.value;
        if (asset.thumbnail === null && lease.value.thumbnail === undefined) {
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const thumbnailScene = new THREE.Scene();
          thumbnailScene.add(ambient.clone(), sun.clone(), fill.clone(), model.clone(true));
          const thumbnailCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
          const distance =
            (Math.max(size.length(), 0.1) / 2 / Math.sin((35 * Math.PI) / 360)) * 1.05;
          thumbnailCamera.position.copy(center).add(new THREE.Vector3(0, size.y * 0.1, distance));
          thumbnailCamera.lookAt(center);
          renderer.setPixelRatio(1);
          renderer.setSize(320, 320, false);
          renderer.setClearColor(0, 0);
          renderer.render(thumbnailScene, thumbnailCamera);
          lease.value.thumbnail = renderer.domElement.toDataURL("image/png");
          renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
          resize();
        }
        if (asset.thumbnail === null && lease.value.thumbnail !== undefined) {
          callbacks.onThumbnail(asset.id, lease.value.thumbnail);
        }
        // Preserve exported units and pivots for manifest assets
        models.set(asset.id, model);
      }
      ready = true;
      update(objects, selectedId);
      callbacks.onStatus("ready");
    } catch (error) {
      if (!disposed) {
        console.error("Failed to load the asset library", error);
        callbacks.onStatus("error");
      }
    }
  }
  void loadAssets();

  return {
    update,
    getDropPosition,
    showDropPosition,
    pickObjectAt,
    worldToLocal,
    setEditingEnabled(enabled) {
      editingEnabled = enabled;
      if (!enabled) {
        cancelDrag();
        cancelTouchGesture();
        cancelWheelEdit();
        showDropPosition(undefined);
      }
      orbit.enabled = enabled && modeManager.usesOrbit() && touchGesture === undefined;
    },
    captureCamera: () => ({
      position: camera.position.toArray() as [number, number, number],
      rotation: camera.quaternion.toArray() as [number, number, number, number],
      fovDegrees: camera.fov,
    }),
    showCamera,
    locateObject(id) {
      if (modeManager.getState().mode !== "editor") return;
      const instance = instanceFor(id);
      if (!instance) return;
      const bounds = new THREE.Box3().setFromObject(instance);
      if (bounds.isEmpty()) return;
      const centre = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.5);
      const direction = camera.position.clone().sub(orbit.target).normalize();
      if (direction.lengthSq() === 0) direction.set(1, 1, 1).normalize();
      const halfFov = Math.atan(
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect),
      );
      camera.position.copy(centre).addScaledVector(direction, (radius / Math.sin(halfFov)) * 1.2);
      orbit.target.copy(centre);
      camera.lookAt(centre);
      orbit.update();
      updateGizmo();
    },
    setNavigationTool(tool) {
      if (tool === navigationTool) return;
      navigationTool = tool;
      cancelDrag();
      cancelTouchGesture();
      cancelWheelEdit();
      applyNavigationTool();
    },
    mobileControls: fpsControls.mobileControls,
    modeManager,
    dispose() {
      if (disposed) {
        return;
      }
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      previewFrame = undefined;
      pendingPreview = undefined;
      cancelDrag();
      cancelTouchGesture();
      cancelWheelEdit();
      disposed = true;
      controller.abort();
      observer.disconnect();
      fpsMeter.dispose();
      fpsControls.dispose();
      unsubscribeMode();
      document.removeEventListener("visibilitychange", visibilityChanged);
      orbit.removeEventListener("change", updateGizmo);
      orbit.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      renderer.domElement.removeEventListener("lostpointercapture", pointerCancel);
      renderer.domElement.removeEventListener("contextmenu", contextMenu);
      host.removeEventListener("wheel", wheel, { capture: true });
      window.removeEventListener("keydown", keyDown);
      // Detach borrowed meshes before disposing only the viewport's grid/gizmo resources
      if (environment !== undefined) {
        scene.remove(environment);
      }
      for (const instance of instances.values()) {
        scene.remove(instance);
      }
      instances.clear();
      hotspotSprites.clear();
      models.clear();
      disposeModels(scene);
      for (const material of hotspotMaterials) {
        material.map?.dispose();
        material.dispose();
      }
      hotspotMaterials.clear();
      for (const lease of leases) {
        lease.release();
      }
      leases.length = 0;
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

function createFpsMeter(host: HTMLDivElement): FpsMeter & { dispose(): void } {
  const el = document.createElement("div");
  el.className = "fps-meter";
  Object.assign(el.style, {
    position: "absolute",
    // Below the Preview and Publish buttons
    top: "4.75rem",
    right: "1.5rem",
    padding: "0.25rem 0.5rem",
    borderRadius: "0.375rem",
    background: "rgba(41, 46, 41, 0.6)",
    color: "#f5f7fa",
    font: "0.75rem/1.4 system-ui, sans-serif",
    zIndex: "2",
    opacity: "0.8",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  // Anchor inside the scene so a taller header still leaves the save status clear
  host.appendChild(el);

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
    dispose(): void {
      el.remove();
    },
  };
}

function applyTransform(instance: THREE.Object3D, transform: Transform) {
  instance.position.fromArray(transform.position);
  instance.quaternion.fromArray(transform.rotation);
  instance.scale.fromArray(transform.scale);
}
