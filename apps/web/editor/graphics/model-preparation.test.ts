import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { prepareModels } from "./model-preparation";
import { createPlacementModel } from "./placement-preview";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  const map = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map, emissiveMap: map, normalMap });
  const model = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const preview = createPlacementModel(model);
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const renderer = {
    compileAsync: vi.fn(async (root: THREE.Object3D) => root),
    initTexture: vi.fn(),
  };
  return { map, normalMap, material, model, preview, camera, scene, renderer };
}

it("prepares both material variants and uploads shared maps once on separate frames", async () => {
  const { map, normalMap, material, model, preview, camera, scene, renderer } = fixture();
  const ready = prepareModels(
    renderer,
    [model, preview.model],
    camera,
    scene,
    new AbortController().signal,
  );
  expect(renderer.compileAsync.mock.calls).toEqual([
    [model, camera, scene],
    [preview.model, camera, scene],
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(renderer.initTexture).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(16);
  expect(renderer.initTexture.mock.calls).toEqual([[map]]);
  await vi.advanceTimersByTimeAsync(16);
  await ready;
  expect(renderer.initTexture.mock.calls).toEqual([[map], [normalMap]]);
  expect(material.map).toBe(map);
  expect(material.normalMap).toBe(normalMap);
  expect(material.transparent).toBe(false);
  expect(model.parent).toBe(null);
  expect(scene.children).toHaveLength(0);
  const mesh = preview.model.children[0] as THREE.Mesh;
  expect(mesh.geometry).toBe(model.geometry);
  expect((mesh.material as THREE.MeshStandardMaterial).map).toBe(map);
  expect((mesh.material as THREE.Material).transparent).toBe(true);
  preview.dispose();
});

it.each(["compiling", "uploading"])(
  "stops preparation after cancellation while %s without releasing borrowed resources",
  async (phase) => {
    const { map, model, camera, scene, renderer, preview } = fixture();
    const controller = new AbortController();
    let finishCompilation!: (model: THREE.Object3D) => void;
    const compiled = new Promise<THREE.Object3D>((resolve) => {
      finishCompilation = resolve;
    });
    renderer.compileAsync.mockReturnValue(compiled);
    const dispose = vi.spyOn(map, "dispose");
    const ready = prepareModels(renderer, [model], camera, scene, controller.signal);
    if (phase === "uploading") {
      finishCompilation(model);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
    }
    controller.abort();
    finishCompilation(model);
    await expect(ready).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    expect(renderer.initTexture).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
    preview.dispose();
  },
);
