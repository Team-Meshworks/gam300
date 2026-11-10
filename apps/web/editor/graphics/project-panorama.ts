import * as THREE from "three";

export async function createProjectPanorama(
  mount: HTMLElement,
  url: string,
  signal: AbortSignal,
): Promise<() => void> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("The panorama could not be loaded.");
  const blob = await response.blob();
  if (blob.size > 2 * 1024 * 1024) throw new Error("The panorama is too large.");
  const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY" });
  if (signal.aborted) {
    bitmap.close();
    throw new DOMException("Cancelled", "AbortError");
  }
  let renderer: THREE.WebGLRenderer | undefined;
  const texture = new THREE.Texture(bitmap);
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  geometry.scale(-1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  try {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 2);
    camera.rotation.order = "YXZ";
    let yaw = 0;
    let pitch = 0;
    let pointer: { id: number; x: number; y: number } | null = null;
    const render = () => {
      camera.rotation.set(pitch, yaw, 0, "YXZ");
      renderer!.render(scene, camera);
    };
    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      renderer!.setSize(Math.max(width, 1), Math.max(height, 1), false);
      camera.aspect = Math.max(width, 1) / Math.max(height, 1);
      camera.updateProjectionMatrix();
      render();
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      mount.focus({ preventScroll: true });
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      mount.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      yaw -= (event.clientX - pointer.x) * 0.004;
      pitch = Math.max(-1.48, Math.min(1.48, pitch - (event.clientY - pointer.y) * 0.004));
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      render();
    };
    const up = () => {
      pointer = null;
    };
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") {
        yaw = 0;
        pitch = 0;
      } else if (event.key === "ArrowLeft") yaw += 0.12;
      else if (event.key === "ArrowRight") yaw -= 0.12;
      else
        pitch = Math.max(-1.48, Math.min(1.48, pitch + (event.key === "ArrowUp" ? 0.12 : -0.12)));
      render();
    };
    mount.append(renderer.domElement);
    renderer.domElement.addEventListener("webglcontextrestored", render);
    mount.addEventListener("pointerdown", down);
    mount.addEventListener("pointermove", move);
    mount.addEventListener("pointerup", up);
    mount.addEventListener("pointercancel", up);
    mount.addEventListener("keydown", key);
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    return () => {
      observer.disconnect();
      mount.removeEventListener("pointerdown", down);
      mount.removeEventListener("pointermove", move);
      mount.removeEventListener("pointerup", up);
      mount.removeEventListener("pointercancel", up);
      mount.removeEventListener("keydown", key);
      renderer!.domElement.removeEventListener("webglcontextrestored", render);
      renderer!.domElement.remove();
      renderer!.dispose();
      texture.dispose();
      geometry.dispose();
      material.dispose();
      bitmap.close();
    };
  } catch (error) {
    renderer?.dispose();
    texture.dispose();
    geometry.dispose();
    material.dispose();
    bitmap.close();
    throw error;
  }
}
