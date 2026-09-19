export type Vector3Tuple = readonly [number, number, number];

export type SceneObject = Readonly<{
  id: string;
  name: string;
  assetId: string;
  transform: Readonly<{
    position: Vector3Tuple;
    rotation: readonly [number, number, number, number];
    scale: Vector3Tuple;
  }>;
}>;
