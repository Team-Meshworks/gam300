import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CatalogueAsset } from "../../shared/assets/catalogue";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";
import type { CameraPose, ProjectScene } from "../../shared/project/project-types";
import { FpsControls } from "../controls/fpsControls";
import { ModeManager } from "./modeManager";

export type ViewportStatus = "loading" | "ready" | "error" | "unsupported";

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
  },
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

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.target.set(0, 0, 0);

  const fpsControls = new FpsControls(camera, renderer.domElement);
  const modeManager = new ModeManager(camera, orbit, fpsControls);
  const fpsMeter = createFpsMeter();

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
    render();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

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

  function update(
    nextObjects: readonly SceneObject[],
    nextSelectedId: string | null,
    nextScene: ProjectScene | null = projectScene,
  ) {
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

  function select(event: MouseEvent) {
    // Visitor look-around is pointer-driven; leave picking to editor mode
    if (modeManager.getState().mode === "visitor") {
      return;
    }
    const ray = screenRay(event.clientX, event.clientY);
    let nearest = Infinity;
    let id: string | null = null;
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
    for (const [objectId, instance] of instances) {
      const hit = raycaster.intersectObject(instance, true)[0];
      if (hit !== undefined && hit.distance < nearest) {
        nearest = hit.distance;
        id = objectId;
      }
    }
    callbacks.onSelect(id);
  }
  renderer.domElement.addEventListener("click", select);

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
    modeManager,
    dispose() {
      disposed = true;
      controller.abort();
      observer.disconnect();
      fpsMeter.dispose();
      fpsControls.dispose();
      orbit.dispose();
      renderer.domElement.removeEventListener("click", select);
      disposeModels(scene, ...models.values());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

function createFpsMeter(): FpsMeter & { dispose(): void } {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "fixed",
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
    dispose(): void {
      el.remove();
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
