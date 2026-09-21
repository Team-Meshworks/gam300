import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { sampleAsset } from "../../shared/assets/sample-asset";
import type { SceneObject, Vector3Tuple } from "../../shared/project/scene-object";

export type ViewportStatus = "loading" | "ready" | "error" | "unsupported";

export function initScene(
  host: HTMLDivElement,
  callbacks: {
    onStatus: (status: ViewportStatus) => void;
    onThumbnail: (url: string) => void;
    onSelect: (id: string | null) => void;
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
  scene.fog = new THREE.Fog(0xe9ece7, 18, 42);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(6, 7, 10);
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
  const dropMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.61, 40),
    new THREE.MeshBasicMaterial({ color: 0xb64b32, side: THREE.DoubleSide }),
  );
  dropMarker.rotation.x = -Math.PI / 2;
  dropMarker.visible = false;
  scene.add(dropMarker);

  const controller = new AbortController();
  let disposed = false;
  let model: THREE.Group | undefined;
  let objects: readonly SceneObject[] = [];
  let selectedId: string | null = null;
  const instances = new Map<string, THREE.Group>();
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

  function update(nextObjects: readonly SceneObject[], nextSelectedId: string | null) {
    objects = nextObjects;
    selectedId = nextSelectedId;
    for (const [id, instance] of instances) {
      if (!objects.some((object) => object.id === id)) {
        scene.remove(instance);
        instances.delete(id);
        bounds.delete(id);
      }
    }
    if (model !== undefined) {
      for (const object of objects) {
        let instance = instances.get(object.id);
        if (instance === undefined) {
          instance = new THREE.Group();
          // Instances share the sample's immutable GPU resources until viewport disposal
          instance.add(model.clone(true));
          instances.set(object.id, instance);
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
    if (model === undefined) {
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
    const ray = screenRay(event.clientX, event.clientY);
    let nearest = Infinity;
    let id: string | null = null;
    // ponytail: sample picking uses bounds; refine to mesh triangles with T02-02's agreed picking contract
    for (const [objectId, box] of bounds) {
      const hit = ray.intersectBox(box, new THREE.Vector3());
      if (hit !== null && hit.distanceTo(ray.origin) < nearest) {
        nearest = hit.distanceTo(ray.origin);
        id = objectId;
      }
    }
    callbacks.onSelect(id);
  }
  renderer.domElement.addEventListener("click", select);

  async function loadSample() {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${sampleAsset.path}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Sample request failed (${response.status})`);
      }
      const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
      if (disposed) {
        disposeModels(gltf.scene);
        return;
      }
      model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center).add(new THREE.Vector3(0, size.y / 2, 0));

      // Render the actual asset once for the shelf, reusing this renderer instead of another WebGL context
      const thumbnailScene = new THREE.Scene();
      thumbnailScene.add(ambient.clone(), sun.clone(), fill.clone(), model.clone(true));
      const thumbnailCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      const distance = (size.length() / 2 / Math.sin((35 * Math.PI) / 360)) * 1.05;
      thumbnailCamera.position.set(0, size.y * 0.55, distance);
      thumbnailCamera.lookAt(0, size.y / 2, 0);
      renderer.setPixelRatio(1);
      renderer.setSize(320, 320, false);
      renderer.setClearColor(0, 0);
      renderer.render(thumbnailScene, thumbnailCamera);
      callbacks.onThumbnail(renderer.domElement.toDataURL("image/png"));
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      update(objects, selectedId);
      resize();
      callbacks.onStatus("ready");
    } catch (error) {
      if (!disposed) {
        console.error("Failed to load the asset", error);
        callbacks.onStatus("error");
      }
    }
  }
  void loadSample();

  return {
    update,
    getDropPosition,
    showDropPosition,
    dispose() {
      disposed = true;
      controller.abort();
      observer.disconnect();
      renderer.domElement.removeEventListener("click", select);
      disposeModels(scene, ...(model === undefined ? [] : [model]));
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
