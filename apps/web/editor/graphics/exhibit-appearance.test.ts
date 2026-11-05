import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createExhibitAppearance } from "./exhibit-appearance";

function canvas() {
  const paint = {
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => paint }) });
}
afterEach(() => vi.unstubAllGlobals());

it("uses metre-based texture coordinates without changing the cached model geometry", () => {
  canvas();
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.MeshStandardMaterial();
  const originalUv = geometry.getAttribute("uv").array.slice();
  const cachedDispose = vi.spyOn(geometry, "dispose");
  const root = new THREE.Group();
  root.position.set(1000, 0, -500);
  root.scale.set(0.5, 2, 1);
  const mesh = new THREE.Mesh(geometry, material);
  root.add(mesh);
  const renderer = createExhibitAppearance();
  renderer.apply(root, { color: "#ffffff", material: "wood" });
  expect(mesh.geometry).not.toBe(geometry);
  const uv = mesh.geometry.getAttribute("uv");
  expect(Math.max(...uv.array)).toBe(8);
  expect(Math.min(...uv.array)).toBe(-8);
  expect(geometry.getAttribute("uv").array).toEqual(originalUv);
  expect((mesh.material as THREE.MeshStandardMaterial).map).not.toBeNull();
  const ownedDispose = vi.spyOn(mesh.geometry, "dispose");
  renderer.apply(root, { color: "#ffffff", material: "plain" });
  expect(mesh.geometry).toBe(geometry);
  expect(ownedDispose).toHaveBeenCalledOnce();
  expect(cachedDispose).not.toHaveBeenCalled();
  renderer.dispose();
});

it("preserves existing glass panes and releases generated geometry on disposal", () => {
  canvas();
  const geometry = new THREE.BoxGeometry();
  const frame = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const pane = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }),
  );
  const root = new THREE.Group();
  root.add(frame, pane);
  const renderer = createExhibitAppearance();
  renderer.apply(root, { color: "#ffffff", material: "tile" });
  expect(pane.geometry).toBe(geometry);
  expect((pane.material as THREE.MeshStandardMaterial).opacity).toBe(0.3);
  const owned = vi.spyOn(frame.geometry, "dispose");
  renderer.dispose();
  expect(owned).toHaveBeenCalledOnce();
  expect(frame.geometry).toBe(geometry);
});
