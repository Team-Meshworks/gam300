import * as THREE from "three";
import { HOTSPOT_ASSET } from "./hotspot";
import type { Vector3Tuple } from "../project/scene-object";

export const HOTSPOT_SIZE = 0.6;

export function hotspotWorldSize(scale: THREE.Vector3): number {
  return HOTSPOT_SIZE * Math.min(Math.abs(scale.x), Math.abs(scale.y));
}

export async function loadHotspotSprite() {
  const texture = await new THREE.TextureLoader().loadAsync(HOTSPOT_ASSET.url);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  sprite.renderOrder = 1000;
  sprite.scale.setScalar(HOTSPOT_SIZE);
  sprite.position.y = HOTSPOT_SIZE / 2;
  return sprite;
}

export function attachHotspotSprite(
  sprite: THREE.Sprite,
  owner: THREE.Object3D,
  [x, y, z]: Vector3Tuple,
) {
  if (sprite.parent !== owner) owner.add(sprite);
  // Saved positions use the marker's bottom centre, including on older projects.
  sprite.position.set(x, y + HOTSPOT_SIZE / 2, z);
  const scale = owner.getWorldScale(new THREE.Vector3());
  const size = hotspotWorldSize(scale);
  sprite.scale.set(size / Math.abs(scale.x), size / Math.abs(scale.y), 1);
}

export function disposeHotspotSprite(sprite: THREE.Sprite) {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
