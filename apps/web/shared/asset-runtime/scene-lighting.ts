import * as THREE from "three";

export function lightExhibitionScene(scene: THREE.Scene) {
  scene.background = new THREE.Color(0xe9ece7);
  const fog = new THREE.Fog(scene.background, 35, 70);
  scene.fog = fog;
  const ambient = new THREE.AmbientLight(0xffffff, 1.4);
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(3, 5, 4);
  // The Starter room walls use glTF's default metallic material. Opposing faces
  // need direct fill light to remain visible from inside the room.
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-3, 1, -3);
  scene.add(ambient, sun, fill);
  return { ambient, sun, fill, fog };
}

export function fitRoomFog(fog: THREE.Fog, bounds: THREE.Box3) {
  const size = bounds.getSize(new THREE.Vector3());
  const scale = Math.max(1, size.x / 10, size.z / 10);
  fog.near = 35 * scale;
  fog.far = 70 * scale;
  return scale;
}
