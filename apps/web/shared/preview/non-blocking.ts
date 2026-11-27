import * as THREE from "three";

export const NON_BLOCKING_HITBOX_NAME = "non-blocking-hitbox";

export function disableMeshRaycast(root: THREE.Object3D) {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh && node.name !== NON_BLOCKING_HITBOX_NAME)
      node.raycast = () => {};
  });
}

export function addNonBlockingHitbox(root: THREE.Object3D) {
  disableMeshRaycast(root);
  if (root.getObjectByName(NON_BLOCKING_HITBOX_NAME) !== undefined) return;
  const bounds = localBounds(root);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const hitbox = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
  );
  hitbox.name = NON_BLOCKING_HITBOX_NAME;
  hitbox.position.copy(center);
  root.add(hitbox);
}

function localBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const relative = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  const part = new THREE.Box3();
  root.traverseVisible((node) => {
    if (!(node instanceof THREE.Mesh) || node.name === NON_BLOCKING_HITBOX_NAME) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    relative.multiplyMatrices(inverse, node.matrixWorld);
    bounds.union(part.copy(node.geometry.boundingBox).applyMatrix4(relative));
  });
  return bounds;
}
