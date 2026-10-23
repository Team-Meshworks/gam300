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

export type NamedViewpoint = Readonly<{
  id: EntityId;
  name: string;
  camera: CameraPose;
}>;

export type ProjectScene = Readonly<{
  id: EntityId;
  name: string;
  environmentAssetId: AssetId | null;
  startCamera: CameraPose;
  // Named starting view; startCamera also keeps a standalone fallback pose.
  startViewpointId?: EntityId;
  // Optional so existing M1 files still open without rewriting them.
  viewpoints?: readonly NamedViewpoint[];
  // Keep the scene list order when saving
  objects: readonly ProjectObject[];
}>;

// Readonly is a compile-time check
// Route edits through the document store
export type ProjectDocument = Readonly<{
  // Saved format version
  // Keep edit counters and server revisions outside this document
  schemaVersion: 1;
  projectId: EntityId;
  title: string;
  // Ordered complete scenes, each with its own environment, objects and views
  scenes: readonly ProjectScene[];
}>;
