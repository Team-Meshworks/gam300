import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CatalogueAsset } from "../../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type { CameraPose, ProjectScene, Transform } from "../../shared/project/project-types";
import { axisDragPosition, beginAxisDrag } from "./translation";

export type ViewportStatus = "loading" | "ready" | "error" | "download-error" | "unsupported";

export function initScene(
  host: HTMLDivElement,
  assets: readonly CatalogueAsset[],
  callbacks: {
    onStatus: (status: ViewportStatus) => void;
    onThumbnail: (id: string, url: string) => void;
    onSelect: (id: string | null) => void;
    onTransform: (id: string, transform: Transform) => void;
  },
) {
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
  let ready = false;
  let objects: readonly SceneObject[] = [];
  let selectedId: string | null = null;
  let projectScene: ProjectScene | null = null;
  let appliedCamera: CameraPose | null = null;
  let environment: THREE.Group | undefined;
  let environmentId: string | undefined;
  const instances = new Map<string, THREE.Group>();
  const instanceAssets = new Map<string, string>();
  const bounds = new Map<string, THREE.Box3>();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag:
    | {
        id: string;
        pointerId: number;
        transform: Transform;
        geometry: NonNullable<ReturnType<typeof beginAxisDrag>>;
        position: THREE.Vector3;
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
    objects = nextObjects;
    selectedId = nextSelectedId;
    projectScene = nextScene;
    // A loaded camera resets the view once
    // Selection and placement keep the same camera-pose reference
    if (projectScene !== null && appliedCamera !== projectScene.startCamera) {
      appliedCamera = projectScene.startCamera;
      camera.position.fromArray(appliedCamera.position);
      camera.quaternion.fromArray(appliedCamera.rotation);
      camera.fov = appliedCamera.fovDegrees;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }

    if (ready && environmentId !== projectScene?.environmentAssetId) {
      // Environment stays at its exported origin, outside the placed-object list
      // Removed instances share resources with models until viewport disposal
      if (environment !== undefined) scene.remove(environment);
      environmentId = projectScene?.environmentAssetId;
      environment =
        environmentId === undefined ? undefined : models.get(environmentId)?.clone(true);
      if (environment !== undefined) scene.add(environment);
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
          // Instances share each asset's immutable GPU resources until viewport disposal
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
    const selectedBounds = selectedId === null ? undefined : bounds.get(selectedId);
    selection.visible = selectedBounds !== undefined;
    if (selectedBounds !== undefined) {
      selection.box.copy(selectedBounds);
    }
    updateGizmo();
    render();
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
    if (!ready) {
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

  function previewPosition(id: string, position: THREE.Vector3) {
    const instance = instances.get(id);
    if (instance === undefined) return;
    instance.position.copy(position);
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
    previewPosition(previous.id, new THREE.Vector3().fromArray(previous.transform.position));
    if (renderer.domElement.hasPointerCapture(previous.pointerId)) {
      renderer.domElement.releasePointerCapture(previous.pointerId);
    }
  }

  function pointerDown(event: PointerEvent) {
    if (!ready || event.button !== 0 || !event.isPrimary || drag !== undefined) return;
    const handle = pickHandle(event.clientX, event.clientY);
    if (handle !== undefined && selectedId !== null) {
      const object = objects.find((entry) => entry.id === selectedId);
      if (object === undefined) return;
      const geometry = beginAxisDrag(
        screenRay(event.clientX, event.clientY),
        camera.position,
        new THREE.Vector3().fromArray(object.transform.position),
        handle.axis,
      );
      // A view almost parallel to the axis has no stable depth solution.
      if (geometry === undefined) return;
      drag = {
        id: object.id,
        pointerId: event.pointerId,
        transform: object.transform,
        geometry,
        position: new THREE.Vector3().fromArray(object.transform.position),
      };
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const ray = screenRay(event.clientX, event.clientY);
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    // The room can block a click even though it isn't a selectable object
    let nearest =
      environment === undefined
        ? Infinity
        : (raycaster.intersectObject(environment, true)[0]?.distance ?? Infinity);
    let id: string | null = null;
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
    const position = axisDragPosition(drag.geometry, screenRay(event.clientX, event.clientY));
    if (position === undefined) return;
    drag.position = position;
    previewPosition(drag.id, position);
  }

  function pointerUp(event: PointerEvent) {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    pointerMove(event);
    const completed = drag;
    drag = undefined;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
    const position = completed.position.toArray() as Vector3Tuple;
    if (position.some((value, index) => value !== completed.transform.position[index])) {
      callbacks.onTransform(completed.id, { ...completed.transform, position });
    } else {
      previewPosition(completed.id, new THREE.Vector3().fromArray(completed.transform.position));
    }
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && drag !== undefined) {
      event.preventDefault();
      cancelDrag();
    }
  }

  function pointerCancel(event: PointerEvent) {
    if (event.pointerId === drag?.pointerId) cancelDrag();
  }

  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointercancel", pointerCancel);
  renderer.domElement.addEventListener("lostpointercapture", pointerCancel);
  window.addEventListener("keydown", keyDown);
  observer.observe(host);
  resize();

  async function loadAssets() {
    try {
      for (const asset of assets) {
        const response = await fetch(asset.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(asset.name + " request failed (" + response.status + ")");
        }
        const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
        if (disposed) {
          disposeModels(gltf.scene);
          return;
        }
        if (asset.placement === "bottom-center") {
          // Preserve the original snowglobe demo's placement convention only for that sample
          const box = new THREE.Box3().setFromObject(gltf.scene);
          const center = box.getCenter(new THREE.Vector3());
          gltf.scene.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
        }
        if (asset.thumbnail === null) {
          const box = new THREE.Box3().setFromObject(gltf.scene);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const thumbnailScene = new THREE.Scene();
          thumbnailScene.add(ambient.clone(), sun.clone(), fill.clone(), gltf.scene.clone(true));
          const thumbnailCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
          const distance =
            (Math.max(size.length(), 0.1) / 2 / Math.sin((35 * Math.PI) / 360)) * 1.05;
          thumbnailCamera.position.copy(center).add(new THREE.Vector3(0, size.y * 0.1, distance));
          thumbnailCamera.lookAt(center);
          renderer.setPixelRatio(1);
          renderer.setSize(320, 320, false);
          renderer.setClearColor(0, 0);
          renderer.render(thumbnailScene, thumbnailCamera);
          callbacks.onThumbnail(asset.id, renderer.domElement.toDataURL("image/png"));
          renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
          resize();
        }
        // Preserve exported units and pivots for manifest assets
        models.set(asset.id, gltf.scene);
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
    dispose() {
      cancelDrag();
      disposed = true;
      controller.abort();
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      renderer.domElement.removeEventListener("lostpointercapture", pointerCancel);
      window.removeEventListener("keydown", keyDown);
      disposeModels(scene, ...models.values());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

function disposeModels(...roots: THREE.Object3D[]) {
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  const images = new Set<ImageBitmap>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) {
        return;
      }
      resources.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        resources.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) {
            resources.add(value);
            const image: unknown = value.source.data;
            if (image instanceof ImageBitmap) {
              images.add(image);
            }
          }
        }
      }
    });
  }
  for (const resource of resources) {
    resource.dispose();
  }
  for (const image of images) {
    image.close();
  }
}
