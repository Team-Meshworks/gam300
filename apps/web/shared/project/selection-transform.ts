import type { ContentObject, ContentScene } from "./project-content";
import type { Transform } from "./project-types";
import { moveAttachedObjects } from "./attached-transforms";
import { isPackagedRoomModel, snapRoomPlacement, type RoomModelPredicate } from "./room-placement";
import { invalid, type ValidationResult } from "./validation-helpers";

export const ROOM_TRANSFORM: Transform = Object.freeze({
  position: [0, 0, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  scale: [1, 1, 1] as const,
});
// Treat the initial environment as a selectable room without inserting a duplicate saved object
export function environmentObject(
  scene: Pick<ContentScene, "id" | "name" | "environmentTransform"> &
    Partial<Pick<ContentScene, "environmentAssetId">>,
): ContentObject {
  return {
    id: scene.id,
    name: scene.name,
    assetId:
      scene.environmentAssetId && scene.environmentAssetId !== "test-room-v1"
        ? scene.environmentAssetId
        : "test-room-module-v1",
    transform: scene.environmentTransform ?? ROOM_TRANSFORM,
    parentId: null,
    visible: true,
    components: [],
  };
}

function roomsOverlap(a: ContentObject, b: ContentObject) {
  if (
    a.transform.position[1] - 0.2 * a.transform.scale[1] >=
      b.transform.position[1] + 3 * b.transform.scale[1] - 1e-5 ||
    b.transform.position[1] - 0.2 * b.transform.scale[1] >=
      a.transform.position[1] + 3 * a.transform.scale[1] - 1e-5
  )
    return false;
  const axes = (object: ContentObject) => {
    const [x, y, z, w] = object.transform.rotation;
    const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
    return [
      [Math.cos(yaw), -Math.sin(yaw)],
      [Math.sin(yaw), Math.cos(yaw)],
    ] as const;
  };
  const aa = axes(a),
    bb = axes(b);
  const dx = a.transform.position[0] - b.transform.position[0],
    dz = a.transform.position[2] - b.transform.position[2];
  return [...aa, ...bb].every(([x, z]) => {
    const radius = (room: ContentObject, basis: typeof aa) =>
      5 *
      (room.transform.scale[0] * Math.abs(x * basis[0][0] + z * basis[0][1]) +
        room.transform.scale[2] * Math.abs(x * basis[1][0] + z * basis[1][1]));
    return Math.abs(dx * x + dz * z) < radius(a, aa) + radius(b, bb) - 1e-5;
  });
}

// Selection is temporary; only the resulting world transforms enter the saved scene
export function moveSceneSelection(
  scene: ContentScene,
  selectedIds: readonly string[],
  anchorId: string,
  proposed: Transform,
  preview = false,
  starterEnvironment = false,
  isRoomModel: RoomModelPredicate = isPackagedRoomModel,
): ValidationResult<ContentScene> {
  const environment = environmentObject(scene);
  const isStarterRoom = (object: ContentObject) =>
    object.id === scene.id
      ? starterEnvironment || scene.environmentAssetId === "test-room-v1"
      : isRoomModel(object.assetId);
  const all =
    scene.environmentVisible === false ? [...scene.objects] : [environment, ...scene.objects];
  const anchor = all.find((object) => object.id === anchorId);
  if (!anchor) return invalid("objectId", "Choose an object in this scene");
  const selected = new Set(
    (selectedIds.includes(anchorId) ? selectedIds : [anchorId]).map((id) => id.toLowerCase()),
  );
  // Expand selected roots through their descendants once so nested selections never move twice
  const parents = new Map(
    [...(scene.groups ?? []), ...scene.objects].map((node) => [
      node.id.toLowerCase(),
      node.parentId?.toLowerCase() ??
        ("assetId" in node && typeof node.assetId === "string" && !isRoomModel(node.assetId)
          ? scene.id.toLowerCase()
          : null),
    ]),
  );
  const moving = new Set(
    all
      .filter((object) => {
        let id: string | null | undefined = object.id.toLowerCase();
        const visited = new Set<string>();
        while (id && !visited.has(id)) {
          if (selected.has(id)) return true;
          visited.add(id);
          id = parents.get(id);
        }
        return false;
      })
      .map((object) => object.id),
  );
  if (
    !preview &&
    all.some(
      (object) => moving.has(object.id) && (object.id === scene.id || isRoomModel(object.assetId)),
    ) &&
    proposed.scale.some((value, axis) => value !== anchor.transform.scale[axis])
  )
    return invalid("transform.scale", "Rooms cannot be scaled");
  // A selected room owns snapping even when its furnishing is the active transform pivot
  const movingRoom = all.find((object) => moving.has(object.id) && isStarterRoom(object));
  if (!isStarterRoom(anchor) && movingRoom) {
    const attached: ContentObject[] = [
      { ...anchor, parentId: null },
      { ...movingRoom, parentId: anchorId },
    ];
    const candidate = moveAttachedObjects(attached, [], anchorId, proposed);
    if (!candidate.ok) return candidate;
    return moveSceneSelection(
      scene,
      [...selectedIds, movingRoom.id],
      movingRoom.id,
      candidate.value[1]!.transform,
      preview,
      starterEnvironment,
      isRoomModel,
    );
  }
  let after = proposed;
  if (isStarterRoom(anchor)) {
    // Shared walls require parallel edges. A free layout can rotate as a whole;
    // individual rooms align their yaw to the stationary layout's nearest wall direction
    const [x, y, z, w] = after.rotation;
    const requestedYaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
    const stationary = all.filter((object) => !moving.has(object.id));
    const reference = stationary.find(isStarterRoom);
    const [rx, ry, rz, rw] = reference?.transform.rotation ?? [0, 0, 0, 1];
    const referenceYaw = Math.atan2(2 * (rw * ry + rx * rz), 1 - 2 * (ry * ry + rz * rz));
    const yaw = reference
      ? referenceYaw + (Math.round((requestedYaw - referenceYaw) / (Math.PI / 2)) * Math.PI) / 2
      : requestedYaw;
    const snapped = reference
      ? snapRoomPlacement(
          after.position,
          stationary,
          undefined,
          undefined,
          (id) => isRoomModel(id) || (isStarterRoom(environment) && id === environment.assetId),
        )
      : null;
    // Preview follows the handle; release must reconnect to the stationary layout
    const position = preview ? after.position : (snapped ?? after.position);
    after = { ...after, position, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
  }
  // Reuse attached-transform math with a temporary parent map; authored hierarchy stays intact
  const temporary = all.map((object) => ({
    ...object,
    parentId: moving.has(object.id) && object.id !== anchorId ? anchorId : null,
  }));
  const moved = moveAttachedObjects(temporary, [], anchorId, after);
  if (!moved.ok) return moved;
  const transforms = new Map(moved.value.map((object) => [object.id, object.transform]));
  const first = transforms.get(scene.id)!;
  // Reject final overlaps while allowing free preview feedback during the gesture
  const roomObjects = all
    .filter(isStarterRoom)
    .map((object) => ({ ...object, transform: transforms.get(object.id)! }));
  for (const room of roomObjects.filter((object) => moving.has(object.id))) {
    if (!preview && roomObjects.some((other) => !moving.has(other.id) && roomsOverlap(room, other)))
      return invalid("transform.position", "That move would overlap another room");
  }
  // Moving the whole layout carries authored starting views, while partial moves leave them fixed
  const moveCamera = (camera: ContentScene["startCamera"]) => {
    const object: ContentObject = {
      ...environment,
      id: "camera",
      parentId: anchorId,
      transform: { position: camera.position, rotation: camera.rotation, scale: [1, 1, 1] },
    };
    const result = moveAttachedObjects([anchor, object], [], anchorId, after);
    if (!result.ok) return camera;
    const transform = result.value[1]!.transform;
    return { ...camera, position: transform.position, rotation: transform.rotation };
  };
  const layoutRooms = all.filter((object) => object.id === scene.id || isRoomModel(object.assetId));
  const wholeLayout =
    layoutRooms.length > 0 && layoutRooms.every((object) => moving.has(object.id));
  return {
    ok: true,
    value: {
      ...scene,
      ...(wholeLayout
        ? {
            startCamera: moveCamera(scene.startCamera),
            viewpoints: (scene.viewpoints ?? []).map((viewpoint) => ({
              ...viewpoint,
              camera: moveCamera(viewpoint.camera),
            })),
          }
        : {}),
      ...(moving.has(scene.id) ? { environmentTransform: first } : {}),
      objects: scene.objects.map((object) =>
        moving.has(object.id) ? { ...object, transform: transforms.get(object.id)! } : object,
      ),
    },
  };
}
