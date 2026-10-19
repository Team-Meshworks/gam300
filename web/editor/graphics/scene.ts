import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ModelCache, disposeModels, type ModelLease } from "../../shared/assets/ModelCache";
import type { CatalogueAsset } from "../../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type {
  CameraPose,
  ProjectScene,
  QuaternionTuple,
  Transform,
} from "../../shared/project/project-types";
import { FpsControls } from "../controls/fpsControls";
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

// One lazy renderer-module owner per editor page, shared across viewport retries/remounts
export const editorModelCache = new ModelCache();
if (import.meta.hot) {
  import.meta.hot.dispose(() => editorModelCache.invalidate());
}

export type ViewportStatus = "loading" | "ready" | "error" | "download-error" | "unsupported";

export interface FpsMeter {
  tick(now: number): void;
}

export interface InitSceneHandle {
  update: (
    nextObjects: readonly SceneObject[],
    nextSelectedId: string | null,
    nextScene?: ProjectScene | null,
  ) => void;
  getDropPosition: (clientX: number, clientY: number) => Vector3Tuple | undefined;
  showDropPosition: (position: Vector3Tuple | undefined) => void;
  setEditingEnabled: (enabled: boolean) => void;
  captureCamera: () => CameraPose;
  showCamera: (pose: CameraPose) => void;
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
  let ready = false;
  let editingEnabled = true;
  let objects: readonly SceneObject[] = [];
  let selectedId: string | null = null;
  let projectScene: ProjectScene | null = null;
  let appliedCamera: CameraPose | null = null;
  let environment: THREE.Group | undefined;
  let environmentId: string | undefined;
  const environmentBounds = new THREE.Box3();
  const instances = new Map<string, THREE.Group>();
  const instanceAssets = new Map<string, string>();
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
      ))
    | undefined;
  let orbitEnabledBeforeDrag = true;
  // Scroll that is shown but not yet saved.
  let wheelEdit:
    { id: string; transform: Transform; current: Transform; timer: number } | undefined;

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
    const distance = camera.position.distanceTo(pivot);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    if (pivot.clone().sub(camera.position).dot(forward) <= camera.near) {
      gizmo.visible = false;
      return;
    }
    const pixelScale =
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
      Math.max(renderer.domElement.clientHeight, 1);
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

  function pickHandle(clientX: number, clientY: number) {
    if (!gizmo.visible) return;
    const pivot = projectedPoint(gizmo.position);
    let nearest = 10;
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

  let lastFrameTime = performance.now();
  const animate = (now: number) => {
    if (disposed) {
      return;
    }
    requestAnimationFrame(animate);
    const delta = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    modeManager.update(delta);
    fpsMeter.tick(now);
    render();
  };
  requestAnimationFrame(animate);

  function showCamera(pose: import("../../shared/project/project-types").CameraPose) {
    if (modeManager.getState().mode !== "editor") return;
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
    orbit.enabled = editingEnabled;
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
    camera.updateMatrixWorld(true);
  }

  function update(
    nextObjects: readonly SceneObject[],
    nextSelectedId: string | null,
    nextScene: ProjectScene | null = projectScene,
  ) {
    if (
      drag !== undefined &&
      (nextSelectedId !== drag.id ||
        nextObjects.find((object) => object.id === drag?.id)?.transform !== drag.transform)
    ) {
      cancelDrag();
    }
    if (
      wheelEdit !== undefined &&
      nextObjects.find((object) => object.id === wheelEdit?.id)?.transform !== wheelEdit.transform
    ) {
      // Undo or another edit replaced the object mid-scroll; drop the unsaved scale
      cancelWheelEdit();
    }
    objects = nextObjects;
    selectedId = nextSelectedId;
    projectScene = nextScene;
    // A loaded camera resets the view once
    // Selection and placement keep the same camera-pose reference
    if (projectScene !== null && appliedCamera !== projectScene.startCamera) {
      modeManager.setMode("editor");
      appliedCamera = projectScene.startCamera;
      showCamera(appliedCamera);
    }

    if (ready && environmentId !== projectScene?.environmentAssetId) {
      // Environment stays at its exported origin, outside the placed-object list
      // Removed instances borrow resources from this viewport's cache leases
      if (environment !== undefined) scene.remove(environment);
      environmentId = projectScene?.environmentAssetId;
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
        bounds.set(object.id, new THREE.Box3().setFromObject(instance));
      }
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

  function previewTransform(id: string, transform: Transform) {
    const instance = instances.get(id);
    if (instance === undefined) return;
    applyTransform(instance, transform);
    const box = new THREE.Box3().setFromObject(instance);
    bounds.set(id, box);
    selection.box.copy(box);
    updateGizmo();
    render();
  }

  function cancelDrag() {
    if (drag === undefined) return;
    const previous = drag;
    drag = undefined;
    orbit.enabled = orbitEnabledBeforeDrag;
    previewTransform(previous.id, previous.transform);
    if (renderer.domElement.hasPointerCapture(previous.pointerId)) {
      renderer.domElement.releasePointerCapture(previous.pointerId);
    }
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
    callbacks.onTransform(completed.id, completed.current);
  }

  function beginDrag(event: PointerEvent, next: NonNullable<typeof drag>) {
    //disable to stop camera
    orbitEnabledBeforeDrag = orbit.enabled;
    orbit.enabled = false;
    drag = next;
    renderer.domElement.setPointerCapture(event.pointerId);
    event.preventDefault();
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
    if (raycaster.intersectObject(instance, true).length === 0) return;
    const geometry = beginFreeRotation(rotation, event.clientX, event.clientY);
    beginDrag(event, { ...shared, currentMode: "freeRotate", geometry });
  }

  function pointerDown(event: PointerEvent) {
    if (!ready || !editingEnabled || (event.button !== 0 && event.button !== 2)) return;
    if (!event.isPrimary || drag !== undefined) return;
    if (modeManager.getState().mode !== "editor") return;
    if (wheelEdit !== undefined) {
      commitWheelEdit();
      event.preventDefault();
      return;
    }
    const handle = pickHandle(event.clientX, event.clientY);
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
    const ray = screenRay(event.clientX, event.clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
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
    callbacks.onSelect(id);
  }

  function pointerMove(event: PointerEvent) {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    const ray = screenRay(event.clientX, event.clientY);
    if (drag.currentMode === "move") {
      const position = axisDragPosition(drag.geometry, ray);
      if (position === undefined) return;
      drag.current = { ...drag.current, position: position.toArray() as Vector3Tuple };
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
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    pointerMove(event);
    const completed = drag;
    drag = undefined;
    orbit.enabled = orbitEnabledBeforeDrag;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (completed.current !== completed.transform) {
      callbacks.onTransform(completed.id, completed.current);
    } else {
      previewTransform(completed.id, completed.transform);
    }
  }

  function wheel(event: WheelEvent) {
    if (
      !ready ||
      !editingEnabled ||
      drag !== undefined ||
      selectedId === null ||
      event.deltaY === 0
    )
      return;
    if (modeManager.getState().mode !== "editor") return;
    const object = objects.find((entry) => entry.id === selectedId);
    const instance = instances.get(selectedId);
    if (object === undefined || instance === undefined) return;
    const ray = screenRay(event.clientX, event.clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
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
    previewTransform(edit.id, edit.current);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || (drag === undefined && wheelEdit === undefined)) return;
    event.preventDefault();
    cancelDrag();
    cancelWheelEdit();
  }

  function pointerCancel(event: PointerEvent) {
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
  const unsubscribeMode = modeManager.subscribe(({ mode }) => {
    cancelDrag();
    cancelWheelEdit();
    // Cancellation must not re-enable orbit controls while visiting
    orbit.enabled = mode === "editor" && editingEnabled;
    selection.visible = mode === "editor" && getSelectionBounds() !== undefined;
    updateGizmo();
  });
  observer.observe(host);
  resize();

  async function loadAssets() {
    try {
      for (const asset of assets) {
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
    setEditingEnabled(enabled) {
      editingEnabled = enabled;
      if (!enabled) {
        cancelDrag();
        cancelWheelEdit();
        showDropPosition(undefined);
      }
      orbit.enabled = enabled && modeManager.getState().mode === "editor";
    },
    captureCamera: () => ({
      position: camera.position.toArray() as [number, number, number],
      rotation: camera.quaternion.toArray() as [number, number, number, number],
      fovDegrees: camera.fov,
    }),
    showCamera,
    modeManager,
    dispose() {
      if (disposed) {
        return;
      }
      cancelDrag();
      cancelWheelEdit();
      disposed = true;
      controller.abort();
      observer.disconnect();
      fpsMeter.dispose();
      fpsControls.dispose();
      unsubscribeMode();
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
      models.clear();
      disposeModels(scene);
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
    top: "0.75rem",
    right: "0.75rem",
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
