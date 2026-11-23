import * as THREE from "three";
import type { CatalogueAsset } from "./catalogue";
import type { ContentComponent } from "../project/project-content";
import { textColorOn, type ExhibitAppearance } from "../project/project-appearance";
import { createTextTexture } from "./text-texture";

export function createDisplayText(
  face: NonNullable<CatalogueAsset["displaySurface"]>,
  text: Extract<ContentComponent, { type: "text" }>,
  physical: boolean,
  appearance?: ExhibitAppearance,
) {
  const group = new THREE.Group();
  group.name = "Display content";
  group.position.fromArray(face.position);
  group.quaternion.fromArray(face.rotation);
  group.translateZ(0.004);
  const transparent =
    text.background === "transparent" || (physical && text.background === undefined);
  const background =
    text.background && text.background !== "transparent" ? text.background : undefined;
  const ink =
    text.color ??
    textColorOn(
      background ??
        (physical && appearance?.material !== "glass"
          ? (appearance?.color ?? "#ffffff")
          : "#ffffff"),
    );
  function plane(height: number, y: number, map: THREE.Texture) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(face.width, height),
      new THREE.MeshBasicMaterial({
        map,
        side: THREE.DoubleSide,
        toneMapped: false,
        transparent,
        depthWrite: !transparent,
      }),
    );
    mesh.position.y = y;
    group.add(mesh);
  }
  const captionHeight = text.caption ? Math.min(face.height * 0.25, face.width * 0.22) : 0;
  const bodyHeight = face.height - captionHeight;
  plane(
    bodyHeight,
    captionHeight / 2,
    createTextTexture(
      "",
      face.width,
      bodyHeight,
      text.runs,
      (text.fontSize ?? (physical ? 28 : 24)) * 4,
      transparent,
      ink,
      background,
    ),
  );
  if (captionHeight)
    plane(
      captionHeight,
      -bodyHeight / 2,
      createTextTexture(text.caption, face.width, captionHeight),
    );
  return group;
}
