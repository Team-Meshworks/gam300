import type { ExhibitAppearance } from "./project-appearance";
import type {
  CameraPose,
  EntityId,
  LegacyProjectDocument,
  ProjectObject,
  ProjectScene,
  Transform,
} from "./project-types";

// Keep formatting as literal text and allowed marks so files cannot inject HTML
export type TextMark = "bold" | "italic" | "underline";
export type TextRun = Readonly<{ text: string; marks: readonly TextMark[] }>;

// Components belong to placed objects; rules refer to their stable IDs rather than list positions
export type ContentComponent =
  | Readonly<{ id: EntityId; type: "hotspot"; label: string }>
  | Readonly<{
      id: EntityId;
      type: "text";
      runs: readonly TextRun[];
      caption: string;
      placement?: Transform;
      background?: string;
      color?: string;
      fontSize?: number;
    }>
  | Readonly<{ id: EntityId; type: "image"; assetId: string; caption: string; alt: string }>
  | Readonly<{
      id: EntityId;
      type: "audio";
      mode: "spatial" | "global";
      assetId: string;
      caption: string;
      loop: boolean;
      volume: number;
    }>
  | Readonly<{
      id: EntityId;
      type: "video";
      assetId: string;
      caption: string;
      loop: boolean;
      volume: number;
    }>
  | Readonly<{
      id: EntityId;
      type: "navigationPoint";
      label: string;
      sceneId: EntityId;
      viewpointId: EntityId;
    }>;

// Triggers describe when a rule starts; runtime timers and event subscriptions are not saved here
export type ProjectTrigger =
  | Readonly<{ type: "click"; targetId: EntityId }>
  | Readonly<{ type: "zoneEnter"; zoneId: EntityId }>
  | Readonly<{ type: "sceneStart" }>
  | Readonly<{ type: "elapsed"; seconds: number }>
  | Readonly<{ type: "gaze"; targetId: EntityId; seconds: number }>
  | Readonly<{ type: "panelClose"; panelId: EntityId }>;

// Actions describe effects for the player to execute after the trigger fires
export type ProjectAction =
  | Readonly<{ type: "showPanel"; panelId: EntityId }>
  | Readonly<{ type: "playMedia"; mediaId: EntityId }>
  | Readonly<{ type: "moveCamera"; viewpointId: EntityId; durationSeconds: number }>
  | Readonly<{ type: "setVisible"; objectId: EntityId; visible: boolean }>
  | Readonly<{ type: "navigateScene"; sceneId: EntityId; viewpointId: EntityId }>
  | Readonly<{ type: "openLink"; url: string }>;

export type ProjectRule = Readonly<{
  id: EntityId;
  enabled: boolean;
  trigger: ProjectTrigger;

  // Array order is execution order; runtime progress belongs outside the saved rule
  actions: readonly ProjectAction[];
}>;

// Parents organize the tree; all object transforms remain in world coordinates
export type ProjectGroup = Readonly<{ id: EntityId; name: string; parentId: EntityId | null }>;
export type ContentObject = ProjectObject &
  Readonly<{
    parentId: EntityId | null;
    visible: boolean;
    components: readonly ContentComponent[];
    appearance?: ExhibitAppearance;
  }>;

// Scale gives the full dimensions of a box centered at the transform position
export type ProjectZone = Readonly<{ id: EntityId; name: string; transform: Transform }>;
export type ProjectViewpoint = Readonly<{ id: EntityId; name: string; camera: CameraPose }>;

// A continuous environment may contain several physical rooms without scene transitions
export type ContentScene = Omit<ProjectScene, "objects"> &
  Readonly<{
    objects: readonly ContentObject[];
    groups: readonly ProjectGroup[];
    zones: readonly ProjectZone[];
    viewpoints: readonly ProjectViewpoint[];
    rules: readonly ProjectRule[];
  }>;

// The version tag lets readers select this contract without silently converting released v1 files
export type ContentProject = Omit<LegacyProjectDocument, "schemaVersion" | "scenes"> &
  Readonly<{
    schemaVersion: 2;
    scenes: readonly ContentScene[];
  }>;
