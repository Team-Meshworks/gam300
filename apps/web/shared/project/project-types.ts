// Plain project data for JSON saving
// Validate imports before using them as a ProjectDocument

// Project, scene and object IDs use UUID strings
// Reuse these IDs when saving or undoing an edit
export type EntityId = string;

// One ID per approved asset version
// Look up file locations through the asset registry
export type AssetId = string;

export type Vector3Tuple = readonly [x: number, y: number, z: number];

// Unit quaternion in x, y, z, w order
export type QuaternionTuple = readonly [x: number, y: number, z: number, w: number];

// Metres, right-handed coordinates, Y up
// Objects attach directly to the scene
export type Transform = Readonly<{
  position: Vector3Tuple;
  rotation: QuaternionTuple;
  // Positive scale on each local axis
  // No mirroring or shear
  scale: Vector3Tuple;
}>;

export type CameraPose = Readonly<{
  position: Vector3Tuple;
  // Camera looks along its local negative Z axis
  rotation: QuaternionTuple;
  // Vertical field of view in degrees
  fovDegrees: number;
}>;

export type ProjectObject = Readonly<{
  id: EntityId;
  name: string;
  assetId: AssetId;
  transform: Transform;
}>;

// A hotspot is an interaction marker attached to one placed object.
// Position is local to that object, so moving the object moves its hotspots.
export type ProjectHotspot = Readonly<{
  id: EntityId;
  objectId: EntityId;
  position: Vector3Tuple;
}>;

export type HotspotDropTarget = Readonly<{
  objectId: EntityId;
  localPosition: Vector3Tuple;
}>;

export type InteractionTrigger =
  | Readonly<{ type: "visitor-clicks-hotspot"; targetHotspotId: EntityId }>
  | Readonly<{ type: "scene-starts" }>
  | Readonly<{ type: "time-elapsed"; seconds?: number }>;

export type InteractionAction =
  | Readonly<{ type: "open-link"; url?: string }>
  | Readonly<{ type: "play-audio"; url?: string }>
  | Readonly<{ type: "print-hi" }>;

export type Interaction = Readonly<{
  when: InteractionTrigger;
  do: InteractionAction;
}>;

export type ProjectScene = Readonly<{
  id: EntityId;
  name: string;
  environmentAssetId: AssetId;
  startCamera: CameraPose;
  // Keep the scene list order when saving
  objects: readonly ProjectObject[];
  // Click triggers can only target these object-bound hotspots
  hotspots: readonly ProjectHotspot[];
  // Authored WHEN -> DO rules run in preview
  interactions: readonly Interaction[];
}>;

// Readonly is a compile-time check
// Route edits through the document store
export type ProjectDocument = Readonly<{
  // Saved format version
  // Keep edit counters and server revisions outside this document
  schemaVersion: 1;
  projectId: EntityId;
  title: string;
  // One scene for M1
  // Validator needs to check the array length
  scenes: readonly ProjectScene[];
}>;
