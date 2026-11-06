import { createModelLoadQueue } from "./model-load-queue";
import {
  environmentObject,
  moveSceneSelection,
  ROOM_TRANSFORM,
} from "../../shared/project/selection-transform";
import { createRoomEntrances } from "../../shared/asset-runtime/room-entrances";
import { visibleModelBounds, visibleRaycastHit, nearestExhibitHit } from "./visible-model-bounds";
import { textSurfacePlacement } from "./text-placement";
import {
  snapRoomPlacement,
  roomFitsGrid,
  roomLayoutTransform,
} from "../../shared/project/room-placement";
import { fitDisplayedObject } from "./fit-displayed-object";
import { placementBody } from "./placement-body";
import {
  resolveObjectPlacement,
  placementSupport,
  type PlacementBody,
} from "./placement-constraints";
import { roomAtPosition } from "./room-at-position";
import { createDisplayContent } from "./display-content";
import { createExhibitAppearance } from "./exhibit-appearance";
import { createPlacementPreview } from "./placement-preview";
import { createActiveClock } from "./active-clock";
import { HOTSPOT_SIZE, hotspotAnchor, hotspotWorldSize } from "./hotspot-anchor";
import { moveAttachedObjects } from "../../shared/project/attached-transforms";
import type {
  ContentComponent,
  ContentObject,
  ContentScene,
} from "../../shared/project/project-content";
import { getStartingCamera } from "../../shared/project/starting-view";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  ModelCache,
  ModelRequestError,
  disposeModels,
  type ModelLease,
} from "../../shared/asset-runtime/ModelCache";
import {
  isStarterRoomEnvironment,
  isStarterRoomModel,
  starterRoomCompanion,
  type CatalogueAsset,
} from "../../shared/asset-runtime/catalogue";
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

// One lazy renderer-module owner per editor page, shared across viewport retries/remounts
export const editorModelCache = new ModelCache();
if (import.meta.hot) {
  import.meta.hot.dispose(() => editorModelCache.invalidate());
}

export type ViewportStatus =
  "loading" | "ready" | "error" | "download-error" | "unsupported" | "authentication-required";

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
  prepareAsset: (id: string) => Promise<boolean>;
  update: (
    nextObjects: readonly SceneObject[],
    nextSelectedId: string | null,
    nextScene?: ProjectScene | null,
    loadGeneration?: number,
    selectedIds?: readonly string[],
  ) => void;
  showTextPlacement: (
    objectId: string,
    component: Extract<ContentComponent, { type: "text" }>,
    clientX: number,
    clientY: number,
  ) => Transform | undefined;
  clearTextPlacement: () => void;
  getDisplayPlacement: (ownerId: string, assetId: string) => Promise<Transform | undefined>;
  resolveTransform: (id: string, transform: Transform) => Transform | undefined;
  resolvePlacement: (assetId: string, position: Vector3Tuple) => Transform | undefined;
  getPlacementParent: (assetId: string, transform: Transform, objectId?: string) => string | null;
  getRoomAtPosition: (position: Vector3Tuple) => string | null;
  getDropPosition: (
    clientX: number,
    clientY: number,
    outsideGrid?: boolean,
    assetId?: string,
  ) => Vector3Tuple | undefined;
  showDropPosition: (position: Vector3Tuple | undefined) => void;
  showPlacementPreview: (
    assetId: string | undefined,
    position: Vector3Tuple | undefined,
    ownerId?: string,
  ) => boolean;
  pickObjectAt: (clientX: number, clientY: number) => string | undefined;
  getHotspotAnchor: (objectId: string) => Vector3Tuple | undefined;
  setEditingEnabled: (enabled: boolean) => void;
  captureCamera: () => CameraPose;
  showCamera: (pose: CameraPose) => void;
  locateObject: (id: string) => void;
  getObjectScreenBounds: (
    id: string,
  ) => { left: number; right: number; top: number; bottom: number } | null;
  setNavigationTool: (tool: NavigationTool) => void;
  toggleDisplayMedia: (id: string) => void;
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
    selectableAssets?: readonly CatalogueAsset[];
  },
  modelCache: ModelCache = editorModelCache,
): InitSceneHandle | undefined {
  const isRoomModel = (id: string) => isStarterRoomModel(assets, id);
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
  const fog = new THREE.Fog(0xe9ece7, 35, 70);
  scene.fog = fog;
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
  const appearanceRenderer = createExhibitAppearance();
  const models = new Map<string, THREE.Group>();
  const leases: ModelLease[] = [];
  const hotspotMaterials = new Set<THREE.SpriteMaterial>();
  const ready = true;
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
  const roomEntrances = createRoomEntrances();
  let selectedIds: readonly string[] = [];
  function findObject(id: string | null) {
    return id === projectScene?.id && projectScene.environmentAssetId
      ? environmentObject(projectScene as ContentScene)
      : objects.find((object) => object.id === id);
  }
  function syncRoomEntrances() {
    roomEntrances.sync([
      ...(isStarterRoomEnvironment(assets, environmentId) && environment ? [environment] : []),
      ...objects.flatMap((object) => {
        const instance = instances.get(object.id);
        return isRoomModel(object.assetId) && instance ? [instance] : [];
      }),
    ]);
  }
  const displays = createDisplayContent(assets, render, models);
  const instanceAssets = new Map<string, string>();
  function instanceFor(objectId: string): THREE.Group | undefined {
    if (objectId === projectScene?.id) return environment;
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
  const placementShapes = new Map<string, { model: THREE.Object3D; shape: PlacementBody }>();
  const lastValidTransforms = new Map<string, { before: Transform; after: Transform }>();
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
              cameraPosition: THREE.Vector3;
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
    const instance = selectedId === null ? undefined : instanceFor(selectedId);
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
      // Billboards inherit position, but stay round under nonuniform owner scale.
      const ownerScale = owner.getWorldScale(new THREE.Vector3());
      const markerSize = hotspotWorldSize(owner);
      sprite.scale.set(markerSize / Math.abs(ownerScale.x), markerSize / Math.abs(ownerScale.y), 1);
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
    if (document.hidden) displays.pause();
    else displays.resumeEditing();
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
    nextSelectedIds: readonly string[] = [],
  ) {
    selectedIds = nextSelectedIds;
    const nextTransform = (id: string) =>
      id === nextScene?.id
        ? (nextScene.environmentTransform ?? ROOM_TRANSFORM)
        : nextObjects.find((object) => object.id === id)?.transform;
    if (
      drag !== undefined &&
      (nextSelectedId !== drag.id || nextTransform(drag.id) !== drag.transform)
    ) {
      cancelDrag();
    }
    if (
      touchGesture !== undefined &&
      (nextSelectedId !== touchGesture.id ||
        nextTransform(touchGesture.id) !== touchGesture.original)
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
    // Saved starting-camera edits must not replace the live editing view.
    // Loading leaves Preview. Scene navigation keeps the same visitor controls and asset cache
    if (startingCamera !== null && loadChanged) modeManager.setMode("editor");
    if (startingCamera !== null && (sceneChanged || reloadCamera)) {
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

    const nextEnvironmentId =
      projectScene?.environmentVisible === false ? undefined : projectScene?.environmentAssetId;
    if (
      ready &&
      (environmentId !== nextEnvironmentId ||
        (!environment && nextEnvironmentId && models.has(nextEnvironmentId)))
    ) {
      // A placement root preserves the cached model's normalization under authored transforms.
      // Removed instances borrow resources from this viewport's cache leases
      if (environment !== undefined) scene.remove(environment);
      environmentId = nextEnvironmentId;
      const model = environmentId === undefined ? undefined : models.get(environmentId);
      environment = model ? new THREE.Group() : undefined;
      if (model && environment) environment.add(model.clone(true));
      environmentBounds.makeEmpty();
      if (environment !== undefined) {
        scene.add(environment);
        environmentBounds.setFromObject(environment);
      }
    }
    if (environment && projectScene) {
      applyTransform(environment, projectScene.environmentTransform ?? ROOM_TRANSFORM);
      environmentBounds.copy(visibleModelBounds(environment));
    }
    // Full-size layouts need the same visible depth as the Starter room's overview.
    const roomSize = environmentBounds.getSize(new THREE.Vector3());
    const viewScale = Math.max(1, roomSize.x / 10, roomSize.z / 10);
    fog.near = 35 * viewScale;
    fog.far = 70 * viewScale;
    const far = 100 * viewScale;
    if (camera.far !== far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    // Keep grid lines above the floor without cutting across thin display bases.
    grid.position.y = projectScene === null ? -0.01 : 0.0001;
    for (const [id, instance] of instances) {
      if (
        !objects.some((object) => object.id === id && object.assetId === instanceAssets.get(id))
      ) {
        // An imported project can reuse an ID with a different model
        appearanceRenderer.release(instance);
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
        appearanceRenderer.apply(instance, (object as Partial<ContentObject>).appearance);
        // Exclude attached markers so selection outlines match the model itself.
        const content = instance.children.find((child) => !(child instanceof THREE.Sprite));
        bounds.set(object.id, visibleModelBounds(content === undefined ? instance : content));
      }
      syncRoomEntrances();
      displays.sync(objects, instances);
      syncHotspots();
    }
    const selectedBounds = getSelectionBounds();
    selection.visible = selectedBounds !== undefined && modeManager.getState().mode === "editor";
    if (selectedBounds !== undefined) {
      selection.box.copy(selectedBounds);
    }
    updateGizmo();
    render();
    if (nextEnvironmentId) void prepareAsset(nextEnvironmentId);
    for (const object of objects) void prepareAsset(object.assetId);
    if (projectScene?.hotspots?.length) void prepareAsset(HOTSPOT_ASSET_ID);
  }

  function getSelectionBounds(): THREE.Box3 | undefined {
    if (selectedIds.length > 1) {
      const combined = new THREE.Box3();
      for (const id of selectedIds) {
        const box = id === projectScene?.id ? environmentBounds : getObjectBounds(id);
        if (box) combined.union(box);
      }
      if (!combined.isEmpty()) return combined;
    }
    // Use the same outline for the room and exhibits
    // Room bounds stay separate from the movable object instances
    if (selectedId === projectScene?.id && !environmentBounds.isEmpty()) {
      return environmentBounds;
    }
    return selectedId === null ? undefined : getObjectBounds(selectedId);
  }

  function getObjectBounds(id: string) {
    const box = bounds.get(id);
    const owner = objects.find((object) => object.id === id);
    if (!box || assets.find((asset) => asset.id === owner?.assetId)?.displayRole !== "physical")
      return box;
    const combined = box.clone();
    for (const child of objects) {
      if ((child as Partial<ContentObject>).parentId !== id) continue;
      const childBox = bounds.get(child.id);
      if (childBox) combined.union(childBox);
    }
    return combined;
  }

  // A locked mouse doesnt move on screen, so it aims with the crosshair in the middle
  function aimPoint(event: MouseEvent) {
    if (!fpsControls.isCaptured()) return { x: event.clientX, y: event.clientY };
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function screenRay(clientX: number, clientY: number) {
    // Physics can move the camera before this frame is rendered.
    camera.updateMatrixWorld(true);
    const rect = renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
      0.5,
    );
    return new THREE.Ray(camera.position, point.unproject(camera).sub(camera.position).normalize());
  }

  function bodyFor(id: string, assetId: string, transform: Transform): PlacementBody | undefined {
    const model = models.get(assetId);
    const asset = assets.find((entry) => entry.id === assetId);
    if (!model || !asset) return;
    let cached = placementShapes.get(assetId);
    if (cached?.model !== model) {
      cached = { model, shape: placementBody(assetId, ROOM_TRANSFORM, model, asset) };
      placementShapes.set(assetId, cached);
    }
    return { ...cached.shape, id, transform };
  }

  function collisionBodies(): PlacementBody[] {
    const result = objects.flatMap((object) => {
      if ((object as Partial<ContentObject>).visible === false) return [];
      const body = bodyFor(object.id, object.assetId, object.transform);
      return body ? [body] : [];
    });
    if (projectScene && projectScene.environmentVisible !== false) {
      const body = bodyFor(
        projectScene.id,
        projectScene.environmentAssetId,
        projectScene.environmentTransform ?? ROOM_TRANSFORM,
      );
      if (body) result.push(body);
    }
    return result;
  }

  function resolveTransform(
    id: string,
    proposed: Transform,
    phase: "drag" | "release" = "release",
  ): Transform | undefined {
    if (id === projectScene?.id || isStarterRoomModel(assets, findObject(id)?.assetId))
      return proposed;
    const object = findObject(id);
    const body = object && bodyFor(id, object.assetId, object.transform);
    if (!body) return;
    const previous = lastValidTransforms.get(id);
    if (previous?.before === object.transform) body.previous = previous.after;
    const bodies = collisionBodies();
    const moved =
      projectScene && selectedIds.length > 1
        ? moveSceneSelection(
            projectScene as ContentScene,
            selectedIds,
            id,
            proposed,
            true,
            isStarterRoomEnvironment(assets, projectScene.environmentAssetId),
            isRoomModel,
          )
        : moveAttachedObjects(
            objects,
            (projectScene as ContentScene | null)?.groups ?? [],
            id,
            proposed,
          );
    if (!moved.ok) return;
    const movedObjects = "objects" in moved.value ? moved.value.objects : moved.value;
    const moving = new Set(
      movedObjects
        .filter(
          (entry) =>
            entry.id === id ||
            entry.transform !== objects.find((original) => original.id === entry.id)?.transform,
        )
        .map((entry) => entry.id),
    );
    // The initial room moves with the selection but is stored outside the object list
    if (
      projectScene &&
      "objects" in moved.value &&
      moved.value.environmentTransform !== projectScene.environmentTransform
    ) {
      moving.add(projectScene.id);
    }
    const obstacles = bodies.filter((entry) => !moving.has(entry.id));
    const result = resolveObjectPlacement(body, proposed, obstacles, phase);
    if (!result) return;
    const next =
      projectScene && selectedIds.length > 1
        ? moveSceneSelection(
            projectScene as ContentScene,
            selectedIds,
            id,
            result,
            true,
            isStarterRoomEnvironment(assets, projectScene.environmentAssetId),
            isRoomModel,
          )
        : moveAttachedObjects(
            objects,
            (projectScene as ContentScene | null)?.groups ?? [],
            id,
            result,
          );
    if (!next.ok) return;
    const children = "objects" in next.value ? next.value.objects : next.value;
    for (const child of children) {
      if (child.id === id || !moving.has(child.id)) continue;
      const original = objects.find((entry) => entry.id === child.id);
      const shape = original && bodyFor(child.id, child.assetId, original.transform);
      if (!shape) return;
      const checked = resolveObjectPlacement(shape, child.transform, obstacles, "drag");
      if (
        !checked ||
        checked.position.some(
          (value, index) => Math.abs(value - child.transform.position[index]!) > 1e-5,
        )
      )
        return;
    }
    return result;
  }

  function resolvePlacement(assetId: string, position: Vector3Tuple): Transform | undefined {
    const transform: Transform = { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    const body = bodyFor("new-placement", assetId, transform);
    if (!body) return;
    const bodies = collisionBodies();
    if (!body.room && bodies.some((entry) => entry.room) && !getRoomAtPosition(position)) return;
    return resolveObjectPlacement(body, transform, bodies, "release");
  }

  function getRoomAtPosition(position: Vector3Tuple): string | null {
    return roomAtPosition(
      position,
      collisionBodies()
        .filter((body) => body.room)
        .map((body) => ({
          id: body.id,
          bounds: body.room!,
          transform: new THREE.Matrix4().compose(
            new THREE.Vector3(...body.transform.position),
            new THREE.Quaternion(...body.transform.rotation),
            new THREE.Vector3(...body.transform.scale),
          ),
        })),
    );
  }

  function getPlacementParent(
    assetId: string,
    transform: Transform,
    objectId?: string,
  ): string | null {
    const body = bodyFor(objectId ?? "new-placement", assetId, transform);
    if (!body) return null;
    const support = placementSupport(body, transform, collisionBodies());
    if (support) return support;
    const parentId = (objects.find((entry) => entry.id === objectId) as ContentObject | undefined)
      ?.parentId;
    const parent = objects.find((entry) => entry.id === parentId);
    if (
      parentId &&
      assets.find((entry) => entry.id === parent?.assetId)?.displayRole !== "physical"
    )
      return parentId;
    const roomId = getRoomAtPosition(transform.position);
    return roomId === projectScene?.id ? null : roomId;
  }

  function getDropPosition(
    clientX: number,
    clientY: number,
    outsideGrid = false,
    assetId?: string,
  ): Vector3Tuple | undefined {
    if (!ready || !editingEnabled || modeManager.getState().mode !== "editor") {
      return;
    }
    const ray = screenRay(clientX, clientY);
    let point = ray.intersectPlane(ground, new THREE.Vector3());
    if (assetId && !outsideGrid) {
      const surfaces: THREE.Object3D[] = [];
      for (const body of collisionBodies()) {
        const instance = body.id === projectScene?.id ? environment : instances.get(body.id);
        if (!instance) continue;
        if (body.display) surfaces.push(instance);
        else if (body.room)
          instance.traverse((node) => {
            if (node instanceof THREE.Mesh && node.name === "floor") surfaces.push(node);
          });
      }
      const hit = new THREE.Raycaster(ray.origin, ray.direction)
        .intersectObjects(surfaces, true)
        .find(visibleRaycastHit);
      if (hit) {
        point = hit.point.clone();
        const stand = collisionBodies().find((body) => {
          if (!body.display) return false;
          const instance = instances.get(body.id);
          for (let node: THREE.Object3D | null = hit.object; node; node = node.parent)
            if (node === instance) return true;
          return false;
        });
        const instance = stand && instances.get(stand.id);
        if (stand?.display && instance) {
          instance.worldToLocal(point);
          point.y = stand.display.top;
          instance.localToWorld(point);
        }
      }
    }
    if (
      point === null ||
      !point
        .toArray()
        .every((value) => Number.isFinite(value) && Math.abs(value) <= (outsideGrid ? 10_000 : 20))
    ) {
      return;
    }
    const position: Vector3Tuple = [point.x, point.y, point.z];
    return assetId && !outsideGrid ? resolvePlacement(assetId, position)?.position : position;
  }

  function showDropPosition(position: Vector3Tuple | undefined) {
    dropMarker.visible = position !== undefined;
    if (position !== undefined) {
      dropMarker.position.set(position[0], 0.02, position[2]);
    }
    render();
  }

  function applyPreviewTransform(id: string, transform: Transform, final = false) {
    const instance = instanceFor(id);
    if (instance === undefined) return;
    const original = findObject(id)?.transform;
    if (original && transform !== original) {
      const resolved = resolveTransform(id, transform, final ? "release" : "drag");
      if (!resolved) return;
      transform = resolved;
    }
    if (original) lastValidTransforms.set(id, { before: original, after: transform });
    // Preview uses the same attachment delta as commit so cancel restores every child too
    const sceneSelection =
      projectScene &&
      (id === projectScene.id ||
        isStarterRoomModel(assets, findObject(id)?.assetId) ||
        selectedIds.length > 1)
        ? moveSceneSelection(
            projectScene as ContentScene,
            selectedIds,
            id,
            transform,
            !final,
            isStarterRoomEnvironment(assets, projectScene.environmentAssetId),
            isRoomModel,
          )
        : null;
    if (sceneSelection && !sceneSelection.ok) {
      if (final) update(objects, selectedId, projectScene, appliedLoadGeneration ?? 0, selectedIds);
      return;
    }
    const moved = sceneSelection?.ok
      ? { ok: true as const, value: sceneSelection.value.objects }
      : moveAttachedObjects(
          objects,
          (projectScene as ContentScene | null)?.groups ?? [],
          id,
          transform,
        );
    if (sceneSelection?.ok && environment) {
      applyTransform(environment, sceneSelection.value.environmentTransform ?? ROOM_TRANSFORM);
      environmentBounds.copy(visibleModelBounds(environment));
    }
    if (!moved.ok) return;
    for (const object of moved.value) {
      const child = instances.get(object.id);
      if (child) {
        applyTransform(child, object.transform);
        bounds.set(object.id, visibleModelBounds(child));
      }
    }
    syncRoomEntrances();
    syncHotspots();
    const box = visibleModelBounds(instance);
    bounds.set(id, box);
    selection.box.copy(getSelectionBounds() ?? box);
    updateGizmo();
    render();
  }

  function commitTransform(id: string, transform: Transform) {
    const authored = findObject(id);
    // Room resizing is visual feedback only; release restores its original size and attached contents
    if (
      authored &&
      (id === projectScene?.id || isRoomModel(authored.assetId)) &&
      transform.scale.some((value, axis) => value !== authored.transform.scale[axis])
    ) {
      applyPreviewTransform(id, authored.transform, true);
      return;
    }
    const previous = lastValidTransforms.get(id);
    const resolved =
      resolveTransform(id, transform) ??
      (previous?.before === authored?.transform
        ? resolveTransform(id, previous!.after)
        : undefined);
    if (!resolved) {
      if (authored) applyPreviewTransform(id, authored.transform, true);
      return;
    }
    transform = resolved;
    // A snap back to the original position creates no store update, so restore the live mesh here too.
    applyPreviewTransform(id, transform, true);
    callbacks.onTransform(id, transform);
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
    commitTransform(completed.id, completed.current);
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
    const object = findObject(id);
    const instance = id === null ? undefined : instanceFor(id);
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
        cameraPosition: camera.position.clone(),
        moving: false,
        finger,
      },
    });
  }

  // First person: holding right click on an object turns it, the camera stays still meanwhile
  function startTurn(event: PointerEvent, id: string | null) {
    const object = findObject(id);
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
    // A pending click cannot turn gravity or leftover walking inertia into an object edit
    // Rebase the grab point without changing the camera's physics or interpolation
    if (!held.geometry.moving && !fpsControls.hasMovementInput()) {
      held.geometry.offset.sub(camera.position.clone().sub(held.geometry.cameraPosition));
    }
    held.geometry.cameraPosition.copy(camera.position);
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
    const object = findObject(selectedId);
    const instance = selectedId === null ? undefined : instanceFor(selectedId);
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
    if (!raycaster.intersectObject(instance, true).some(visibleRaycastHit)) return;
    const geometry = beginFreeRotation(rotation, event.clientX, event.clientY);
    beginDrag(event, { ...shared, currentMode: "freeRotate", geometry });
  }

  function pick(clientX: number, clientY: number) {
    const ray = screenRay(clientX, clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    const nearest =
      environment === undefined
        ? Infinity
        : (raycaster.intersectObject(environment, true).find(visibleRaycastHit)?.distance ??
          Infinity);
    // A wall or floor hit selects the room; a closer exhibit can still win the pick
    let id: string | null = Number.isFinite(nearest) ? (projectScene?.id ?? null) : null;
    const exhibit = pickExhibit(raycaster);
    if (exhibit && exhibit.distance < nearest) id = exhibit.id;
    return id;
  }

  function pickObjectAt(clientX: number, clientY: number): string | undefined {
    const ray = screenRay(clientX, clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    return pickExhibit(raycaster)?.id;
  }

  function pickExhibit(raycaster: THREE.Raycaster) {
    const hits = [];
    for (const [objectId, instance] of instances) {
      const hit = raycaster.intersectObject(instance, true).find(visibleRaycastHit);
      if (!hit) continue;
      const object = objects.find((entry) => entry.id === objectId);
      const materials =
        hit.object instanceof THREE.Mesh
          ? Array.isArray(hit.object.material)
            ? hit.object.material
            : [hit.object.material]
          : [];
      hits.push({
        id: objectId,
        distance: hit.distance,
        parentId: (object as ContentObject | undefined)?.parentId ?? null,
        glass:
          assets.find((entry) => entry.id === object?.assetId)?.displayRole === "physical" &&
          materials.length > 0 &&
          materials.every((material) => material.transparent && material.opacity < 0.9),
      });
    }
    return nearestExhibitHit(hits);
  }

  function getHotspotAnchor(objectId: string): Vector3Tuple | undefined {
    const instance = instanceFor(objectId);
    if (instance === undefined) return;
    const object = objects.find((item) => item.id.toLowerCase() === objectId.toLowerCase());
    const model = object === undefined ? undefined : models.get(object.assetId);
    return model === undefined ? undefined : hotspotAnchor(model, instance, camera);
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
    const handle = pickHandle(
      event.clientX,
      event.clientY,
      event.pointerType === "touch" ? MOBILE_GIZMO_HIT_RADIUS : 10,
    );
    // Explicit handles take priority; dragging the rest of the view still uses the camera tool.
    if (cameraToolActive() && handle === undefined) return;
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
      if (findObject(id) !== undefined) {
        callbacks.onSelect(id);
        startCarry(event, id);
        return;
      }
    }
    if (event.button === 2) {
      startRotation(event, handle);
      return;
    }
    if (handle !== undefined && selectedId !== null) {
      const object = findObject(selectedId);
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
          const object = findObject(selectedId);
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
          commitTransform(completed.id, completed.current);
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
        displays.toggle(click.target);
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
      commitTransform(completed.id, completed.current);
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
    const object = findObject(selectedId);
    const instance = instanceFor(selectedId);
    if (object === undefined || instance === undefined) return;
    const aim = aimPoint(event);
    const ray = screenRay(aim.x, aim.y);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    raycaster.camera = camera;
    if (!raycaster.intersectObject(instance, true).some(visibleRaycastHit)) return;
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
    displays.setPreview(mode === "visitor");
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

  function loadingChanged() {
    if (disposed) return;
    const failures = [...modelLoads.errors.values()];
    callbacks.onStatus(
      failures.some(
        (error) => error instanceof ModelRequestError && [401, 403].includes(error.status),
      )
        ? "authentication-required"
        : modelLoads.pending
          ? "loading"
          : failures.length
            ? "error"
            : "ready",
    );
  }
  const modelLoads = createModelLoadQueue(async (id) => {
    if (disposed) return;
    const asset = assets.find((asset) => asset.id === id);
    if (!asset) throw new Error("Missing model: " + id);
    await loadAsset(asset);
    if (!disposed)
      update(objects, selectedId, projectScene, appliedLoadGeneration ?? 0, selectedIds);
  }, loadingChanged);
  function prepareAsset(id: string): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const asset = assets.find((asset) => asset.id === id);
    if (asset && asset.kind !== "model" && asset.kind !== "environment")
      return Promise.resolve(true);
    return modelLoads.request(id);
  }
  async function loadAsset(asset: CatalogueAsset) {
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
        // Editor annotations stay readable even through the owner's geometry.
        depthTest: false,
        depthWrite: false,
      });
      hotspotMaterials.add(material);
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 1000;
      sprite.scale.setScalar(HOTSPOT_SIZE);
      sprite.position.y = HOTSPOT_SIZE / 2;
      const model = new THREE.Group();
      model.add(sprite);
      models.set(asset.id, model);
      return;
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
      const distance = (Math.max(size.length(), 0.1) / 2 / Math.sin((35 * Math.PI) / 360)) * 1.05;
      const offset =
        asset.kind === "environment"
          ? new THREE.Vector3(0.7, 1.3, 1).normalize().multiplyScalar(distance)
          : new THREE.Vector3(0, size.y * 0.1, distance);
      thumbnailCamera.position.copy(center).add(offset);
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
  // Defer until the caller has supplied the recovered scene; an empty project downloads no models.
  queueMicrotask(loadingChanged);

  const placementPreview = createPlacementPreview(scene, models);
  const textPreview = createDisplayContent(assets, render, models);
  let textPreviewRoot: THREE.Group | undefined;
  let hiddenText: THREE.Object3D | undefined;
  function clearTextPlacement() {
    textPreview.dispose();
    if (textPreviewRoot) scene.remove(textPreviewRoot);
    textPreviewRoot = undefined;
    if (hiddenText) hiddenText.visible = true;
    hiddenText = undefined;
  }
  function showTextPlacement(
    objectId: string,
    component: Extract<ContentComponent, { type: "text" }>,
    clientX: number,
    clientY: number,
  ): Transform | undefined {
    const object = objects.find((entry) => entry.id === objectId),
      owner = instances.get(objectId);
    if (!object || !owner || !owner.children[0]) {
      clearTextPlacement();
      return;
    }
    owner.updateMatrixWorld(true);
    const ray = screenRay(clientX, clientY),
      raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    const hit = raycaster
      .intersectObject(owner.children[0], true)
      .find((hit) => visibleRaycastHit(hit) && !!hit.face);
    if (!hit?.face || !(hit.object instanceof THREE.Mesh)) {
      if (textPreviewRoot) textPreviewRoot.visible = false;
      return;
    }
    const inverse = owner.matrixWorld.clone().invert(),
      localMatrix = inverse.clone().multiply(hit.object.matrixWorld);
    const normal = hit.face.normal
      .clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(localMatrix))
      .normalize();
    const meshBounds = new THREE.Box3()
      .setFromBufferAttribute(hit.object.geometry.attributes.position as THREE.BufferAttribute)
      .applyMatrix4(localMatrix);
    const placement = textSurfacePlacement(
      meshBounds,
      hit.point.clone().applyMatrix4(inverse),
      normal,
    );
    if (!textPreviewRoot) {
      textPreviewRoot = new THREE.Group();
      textPreviewRoot.name = "text-placement-preview";
      scene.add(textPreviewRoot);
      hiddenText = owner.getObjectByName("Display content");
      if (hiddenText) hiddenText.visible = false;
    }
    textPreviewRoot.visible = true;
    textPreviewRoot.position.copy(owner.position);
    textPreviewRoot.quaternion.copy(owner.quaternion);
    textPreviewRoot.scale.copy(owner.scale);
    const previewObject: ContentObject = {
      ...object,
      parentId: (object as Partial<ContentObject>).parentId ?? null,
      visible: (object as Partial<ContentObject>).visible ?? true,
      components: [
        { ...component, placement: { ...placement, position: [0, 0, 0], rotation: [0, 0, 0, 1] } },
      ],
    };
    textPreview.sync([previewObject], new Map([[objectId, textPreviewRoot]]));
    const label = textPreviewRoot.getObjectByName("Display content");
    if (label) {
      label.position.fromArray(placement.position);
      label.quaternion.fromArray(placement.rotation);
      label.translateZ(0.004);
    }
    return placement;
  }

  return {
    update,
    prepareAsset,
    showTextPlacement,
    clearTextPlacement,
    getDropPosition,
    async getDisplayPlacement(ownerId, assetId) {
      if (!(await prepareAsset(assetId)) || disposed) return;
      const owner = objects.find((object) => object.id === ownerId);
      const metadata = assets.find((asset) => asset.id === owner?.assetId);
      const caseModel = owner && models.get(owner.assetId);
      const model = models.get(assetId);
      if (!owner || metadata?.displayRole !== "physical" || !caseModel || !model) return;
      const fitted = fitDisplayedObject(
        owner,
        metadata.displayTop ?? 0,
        new THREE.Box3().setFromObject(caseModel),
        new THREE.Box3().setFromObject(model),
        bodyFor(owner.id, owner.assetId, owner.transform)?.display?.interior,
      );
      const body = fitted && bodyFor("display-placement", assetId, fitted);
      return body && fitted
        ? resolveObjectPlacement(body, fitted, collisionBodies(), "release")
        : undefined;
    },
    getRoomAtPosition,
    resolveTransform,
    resolvePlacement,
    getPlacementParent,
    showDropPosition,
    showPlacementPreview(id, position, ownerId) {
      // Whole layouts replace the environment at its current frame, not at the drop cursor.
      const layout =
        assets.some((asset) => asset.id === id && asset.kind === "environment") &&
        !isStarterRoomEnvironment(assets, id);
      if (layout && position) position = projectScene?.environmentTransform?.position ?? [0, 0, 0];
      if (
        projectScene &&
        isStarterRoomEnvironment(assets, id) &&
        isStarterRoomEnvironment(assets, projectScene.environmentAssetId)
      ) {
        const companion = starterRoomCompanion(callbacks.selectableAssets ?? assets);
        if (!companion) {
          placementPreview.show(undefined, undefined);
          render();
          return false;
        }
        id = companion.id;
      }
      if (id && !models.has(id)) {
        void prepareAsset(id);
        return false;
      }
      const room = isStarterRoomEnvironment(assets, id) || isStarterRoomModel(assets, id);
      const rotation =
        id && isRoomModel(id)
          ? roomLayoutTransform(objects, projectScene, isRoomModel)?.rotation
          : layout
            ? projectScene?.environmentTransform?.rotation
            : undefined;
      const requestedFits = position !== undefined && (!room || roomFitsGrid(position, rotation));
      if (id && isRoomModel(id) && position && requestedFits)
        position =
          snapRoomPlacement(
            position,
            objects,
            projectScene?.environmentVisible !== false &&
              isStarterRoomEnvironment(assets, projectScene?.environmentAssetId)
              ? "test-room-v1"
              : undefined,
            roomLayoutTransform(objects, projectScene, isRoomModel),
            isRoomModel,
          ) ?? undefined;
      let scale = 1;
      if (id === HOTSPOT_ASSET_ID && position !== undefined) {
        const target = ownerId ?? selectedId;
        const owner = target === null ? undefined : instanceFor(target);
        const anchor = target === null ? undefined : getHotspotAnchor(target);
        position = undefined;
        if (owner && anchor) {
          const world = owner.localToWorld(
            new THREE.Vector3(anchor[0], anchor[1] + HOTSPOT_SIZE / 2, anchor[2]),
          );
          scale = hotspotWorldSize(owner) / HOTSPOT_SIZE;
          world.y -= (HOTSPOT_SIZE / 2) * scale;
          position = world.toArray() as Vector3Tuple;
        }
      }
      if (id && position && !room && id !== HOTSPOT_ASSET_ID) {
        position = resolvePlacement(id, position)?.position;
      }
      const valid =
        position !== undefined && (!room || (requestedFits && roomFitsGrid(position, rotation)));
      placementPreview.show(id, position, scale, rotation, valid);
      render();
      return valid;
    },
    pickObjectAt,
    getHotspotAnchor,
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
    getObjectScreenBounds(id) {
      const box = getObjectBounds(id);
      if (!box || box.isEmpty()) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x, y, z).project(camera);
            if (point.z < -1 || point.z > 1) return null;
            const screenX = rect.left + ((point.x + 1) * rect.width) / 2;
            const screenY = rect.top + ((1 - point.y) * rect.height) / 2;
            left = Math.min(left, screenX);
            right = Math.max(right, screenX);
            top = Math.min(top, screenY);
            bottom = Math.max(bottom, screenY);
          }
      return { left, right, top, bottom };
    },
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
    toggleDisplayMedia: (id) => displays.toggle(id),
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
      clearTextPlacement();
      placementPreview.clear();
      roomEntrances.dispose();
      appearanceRenderer.dispose();
      disposed = true;
      displays.dispose();
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
      placementShapes.clear();
      lastValidTransforms.clear();
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
    background: "var(--scene-hint-background)",
    color: "var(--scene-hint-text)",
    font: "0.75rem/1.4 system-ui, sans-serif",
    zIndex: "2",
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
