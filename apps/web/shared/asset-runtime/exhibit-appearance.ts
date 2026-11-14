import * as THREE from "three";
import type { ExhibitAppearance, ExhibitMaterial } from "../project/project-appearance";

// Local procedural swatches need no remote images or authored texture URLs.
function textureFor(kind: ExhibitMaterial) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const paint = canvas.getContext("2d")!;
  paint.fillStyle = kind === "wood" ? "#bd8a54" : kind === "leather" ? "#675349" : "#e4e3de";
  paint.fillRect(0, 0, 128, 128);
  paint.strokeStyle = kind === "wood" ? "#88613e" : "#989b98";
  paint.lineWidth = kind === "tile" ? 2 : 1;
  if (kind === "wood" || kind === "marble") {
    for (let row = 0; row < 128; row += kind === "wood" ? 5 : 24) {
      paint.beginPath();
      for (let x = 0; x <= 128; x += 2)
        paint.lineTo(x, row + Math.sin(x / 14 + row) * (kind === "wood" ? 2 : 14));
      paint.stroke();
    }
  } else if (kind === "tile") {
    for (let n = 0; n <= 128; n += 32) {
      paint.beginPath();
      paint.moveTo(n, 0);
      paint.lineTo(n, 128);
      paint.moveTo(0, n);
      paint.lineTo(128, n);
      paint.stroke();
    }
  } else {
    for (let n = 0; n < 400; n++) {
      paint.fillStyle = n % 2 ? "#858984" : "#f1f1eb";
      paint.fillRect((n * 43) % 128, (n * 73) % 128, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Exported display UVs use inconsistent scales; project the pattern in metres per face.
function texturedGeometry(mesh: THREE.Mesh) {
  const geometry = mesh.geometry.clone();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!normals) geometry.computeVertexNormals();
  const faceNormals = geometry.getAttribute("normal");
  mesh.updateWorldMatrix(true, false);
  const scale = mesh.getWorldScale(new THREE.Vector3());
  const uv = new Float32Array(positions.count * 2);
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index) * Math.abs(scale.x) * 4;
    const y = positions.getY(index) * Math.abs(scale.y) * 4;
    const z = positions.getZ(index) * Math.abs(scale.z) * 4;
    const nx = Math.abs(faceNormals.getX(index));
    const ny = Math.abs(faceNormals.getY(index));
    const nz = Math.abs(faceNormals.getZ(index));
    uv[index * 2] = nx >= ny && nx >= nz ? z : x;
    uv[index * 2 + 1] = ny > nx && ny >= nz ? z : y;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

export function createExhibitAppearance() {
  const applied = new WeakMap<THREE.Object3D, string>();
  const originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const owned = new Map<THREE.Mesh, THREE.Material[]>();
  const geometries = new Map<THREE.Mesh, THREE.BufferGeometry>();
  const sourceGeometries = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
  const textures = new Map<ExhibitMaterial, THREE.Texture>();
  function release(mesh: THREE.Mesh) {
    for (const material of owned.get(mesh) ?? []) material.dispose();
    owned.delete(mesh);
    const geometry = geometries.get(mesh);
    if (geometry) {
      mesh.geometry = sourceGeometries.get(mesh)!;
      geometry.dispose();
      geometries.delete(mesh);
    }
  }
  return {
    apply(root: THREE.Object3D, appearance: ExhibitAppearance | undefined) {
      const key = JSON.stringify(appearance ?? null);
      if (applied.get(root) === key) return;
      applied.set(root, key);
      root.traverse((mesh) => {
        if (!(mesh instanceof THREE.Mesh)) return;
        if (!originals.has(mesh)) originals.set(mesh, mesh.material);
        release(mesh);
        const source = originals.get(mesh)!;
        if (!appearance) {
          mesh.material = source;
          return;
        }
        const copies: THREE.Material[] = [];
        let textured = false;
        const copy = (base: THREE.Material) => {
          const material = base.clone();
          copies.push(material);
          // Keep a case's existing glass panes transparent; style its solid frame only.
          if (
            material instanceof THREE.MeshStandardMaterial &&
            !(base.transparent && base.opacity < 0.9)
          ) {
            material.color.set(appearance.color);
            material.roughness =
              appearance.material === "ceramic"
                ? 0.12
                : appearance.material === "glass"
                  ? 0.05
                  : 0.65;
            if (appearance.material === "glass") {
              material.transparent = true;
              material.opacity = 0.35;
              material.depthWrite = false;
            }
            if (!["plain", "glass", "ceramic"].includes(appearance.material)) {
              if (!textures.has(appearance.material))
                textures.set(appearance.material, textureFor(appearance.material));
              material.map = textures.get(appearance.material)!;
              textured = true;
            } else material.map = null;
          }
          return material;
        };
        mesh.material = Array.isArray(source) ? source.map(copy) : copy(source);
        if (textured) {
          if (!sourceGeometries.has(mesh)) sourceGeometries.set(mesh, mesh.geometry);
          mesh.geometry = texturedGeometry(mesh);
          geometries.set(mesh, mesh.geometry);
        }
        owned.set(mesh, copies);
      });
    },
    release(root: THREE.Object3D) {
      root.traverse((mesh) => {
        if (mesh instanceof THREE.Mesh) release(mesh);
      });
    },
    dispose() {
      for (const mesh of owned.keys()) release(mesh);
      for (const texture of textures.values()) texture.dispose();
      textures.clear();
    },
  };
}
