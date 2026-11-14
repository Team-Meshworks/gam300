import { textColorOn } from "../../shared/project/project-appearance";
import * as THREE from "three";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { ContentComponent, ContentObject } from "../../shared/project/project-content";
import type { SceneObject } from "../../shared/project/scene-object";
import { containDisplay } from "./display-layout";
import { createTextTexture as textCanvas } from "../../shared/asset-runtime/text-texture";

type DisplayContent = Extract<ContentComponent, { type: "text" | "image" | "video" }>;
type Display = {
  signature: string;
  group: THREE.Group;
  dispose: () => void;
  pause: () => void;
  setPreview: (active: boolean) => void;
  toggle: () => void;
};

export function createDisplayContent(
  assets: readonly CatalogueAsset[],
  redraw: () => void,
  models: ReadonlyMap<string, THREE.Object3D> = new Map(),
) {
  const registry = new Map(assets.map((asset) => [asset.id, asset]));
  const displays = new Map<string, Display>();
  let preview = false;

  function make(
    owner: THREE.Group,
    asset: CatalogueAsset,
    content: DisplayContent,
    signature: string,
  ): Display | undefined {
    const physical = asset.displayRole === "physical";
    let resolved = asset.displaySurface;
    if (physical && content.type === "text") {
      const model = models.get(asset.id);
      if (!model) return;
      const box = new THREE.Box3().setFromObject(model),
        size = box.getSize(new THREE.Vector3());
      const width = Math.max(0.2, size.x * 0.9);
      resolved = {
        position: [
          (box.min.x + box.max.x) / 2,
          box.min.y + (asset.displayTop ?? size.y) / 2,
          box.max.z + 0.006,
        ],
        rotation: [0, 0, 0, 1],
        width,
        height: width * 0.6,
      };
    }
    if (content.type === "text" && content.placement)
      resolved = {
        position: content.placement.position,
        rotation: content.placement.rotation,
        width: content.placement.scale[0],
        height: content.placement.scale[1],
      };
    if (!resolved) return;
    const surface = resolved;
    const appearance = (owner.userData.captionAppearance ?? {}) as {
      color?: string;
      material?: string;
    };
    const background = content.type === "text" ? content.background : undefined;
    const transparent = background === "transparent" || (physical && background === undefined);
    const ink =
      (content.type === "text" ? content.color : undefined) ??
      textColorOn(
        background && background !== "transparent"
          ? background
          : physical && appearance.material !== "glass"
            ? (appearance.color ?? "#ffffff")
            : "#ffffff",
      );
    const group = new THREE.Group();
    group.name = "Display content";
    group.position.fromArray(surface.position);
    group.quaternion.fromArray(surface.rotation);
    // Offset toward the viewer to avoid z-fighting with the exported panel surface.
    group.translateZ(0.004);
    owner.add(group);
    const textures = new Set<THREE.Texture>();
    const materials: THREE.MeshBasicMaterial[] = [];
    const geometries: THREE.PlaneGeometry[] = [];
    let disposed = false;
    let video: HTMLVideoElement | undefined;
    let image: HTMLImageElement | undefined;
    let videoReady = false;
    function plane(width: number, height: number, y: number, texture: THREE.Texture) {
      textures.add(texture);
      const geometry = new THREE.PlaneGeometry(width, height);
      geometries.push(geometry);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        toneMapped: false,
        transparent,
        depthWrite: !transparent,
      });
      materials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = y;
      group.add(mesh);
      return mesh;
    }
    const captionHeight =
      content.type === "text" && content.caption
        ? Math.min(surface.height * 0.25, surface.width * 0.22)
        : 0;
    const mediaHeight = surface.height - captionHeight;
    const main = plane(
      surface.width,
      mediaHeight,
      captionHeight / 2,
      textCanvas(
        content.type === "text" ? "" : `Loading ${content.type}…`,
        surface.width,
        mediaHeight,
        content.type === "text" ? content.runs : undefined,
        content.type === "text" ? (content.fontSize ?? (physical ? 28 : 24)) * 4 : 32,
        transparent,
        ink,
        background && background !== "transparent" ? background : "#fffaf0",
      ),
    );
    if (content.type === "text" && content.caption)
      plane(
        surface.width,
        captionHeight,
        -mediaHeight / 2,
        textCanvas(content.caption, surface.width, captionHeight),
      );
    function replace(texture: THREE.Texture, width = surface.width, height = mediaHeight) {
      if (disposed) {
        texture.dispose();
        return;
      }
      textures.add(texture);
      const fit = containDisplay(surface.width, mediaHeight, width, height);
      main.scale.set(fit.width / surface.width, fit.height / mediaHeight, 1);
      main.material.map = texture;
      main.material.needsUpdate = true;
      redraw();
    }
    function failure() {
      if (!disposed)
        replace(
          textCanvas(
            `${content.type === "image" ? "Image" : "Video"} unavailable. Reopen content to choose another asset.`,
            surface.width,
            mediaHeight,
          ),
        );
    }
    if (content.type !== "text") {
      const media = registry.get(content.assetId);
      if (!media || media.kind !== content.type) failure();
      else if (content.type === "image") {
        image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
          if (disposed || !image) return;
          const texture = new THREE.Texture(image);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          replace(texture, image.naturalWidth, image.naturalHeight);
        };
        image.onerror = failure;
        image.src = media.url;
      } else {
        video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.preload = "metadata";
        video.playsInline = true;
        video.loop = !preview || content.loop;
        video.volume = content.volume;
        video.muted = !preview;
        video.onloadeddata = () => {
          if (disposed || !video) return;
          videoReady = true;
          const texture = new THREE.VideoTexture(video);
          texture.colorSpace = THREE.SRGBColorSpace;
          replace(texture, video.videoWidth, video.videoHeight);
          if (!preview && !document.hidden) void video.play().catch(() => {});
        };
        video.onerror = failure;
        // Editing plays silently; visitor playback still requires a click.
        video.src = media.url;
        video.load();
        replace(textCanvas("Video · click in Preview to play", surface.width, mediaHeight));
      }
    }
    return {
      signature,
      group,
      pause() {
        video?.pause();
      },
      setPreview(active) {
        if (!video) return;
        video.pause();
        video.muted = !active;
        video.loop = !active || (content.type === "video" && content.loop);
        if (!active && videoReady && !document.hidden) void video.play().catch(() => {});
      },
      toggle() {
        if (!preview || document.hidden || !video || disposed) return;
        if (!video.paused) video.pause();
        else
          void video.play().catch(() => {
            if (!disposed && !videoReady)
              replace(
                textCanvas(
                  "Video could not play. Click again to retry.",
                  surface.width,
                  mediaHeight,
                ),
              );
          });
      },
      dispose() {
        disposed = true;
        group.removeFromParent();
        if (image) {
          image.onload = null;
          image.onerror = null;
          image.removeAttribute("src");
        }
        if (video) {
          video.pause();
          video.onloadeddata = null;
          video.onerror = null;
          video.removeAttribute("src");
          video.load();
        }
        textures.forEach((texture) => texture.dispose());
        materials.forEach((material) => material.dispose());
        geometries.forEach((geometry) => geometry.dispose());
      },
    };
  }
  return {
    sync(objects: readonly SceneObject[], owners: ReadonlyMap<string, THREE.Group>) {
      const retained = new Set<string>();
      for (const object of objects) {
        const asset = registry.get(object.assetId);
        const content = (object as ContentObject).components?.find(
          (entry): entry is DisplayContent =>
            asset?.displayRole === "digital"
              ? entry.type === "text" || entry.type === "image" || entry.type === "video"
              : entry.type === "text" && entry.runs.some((run) => run.text.trim()),
        );
        const owner = owners.get(object.id);
        if (!asset?.displayRole || !owner || !content) continue;
        retained.add(object.id);
        const signature = JSON.stringify([
          object.assetId,
          content,
          (object as ContentObject).appearance,
        ]);
        const old = displays.get(object.id);
        if (old?.signature === signature && old.group.parent === owner) continue;
        old?.dispose();
        displays.delete(object.id);
        owner.userData.captionAppearance = (object as ContentObject).appearance;
        const next = make(owner, asset, content, signature);
        if (next) displays.set(object.id, next);
      }
      for (const [id, display] of displays) {
        if (!retained.has(id)) {
          display.dispose();
          displays.delete(id);
        }
      }
    },
    setPreview(active: boolean) {
      if (preview === active) return;
      preview = active;
      displays.forEach((display) => display.setPreview(active));
    },
    pause() {
      displays.forEach((display) => display.pause());
    },
    resumeEditing() {
      if (!preview && !document.hidden) displays.forEach((display) => display.setPreview(false));
    },
    toggle(id: string) {
      displays.get(id)?.toggle();
    },
    dispose() {
      displays.forEach((display) => display.dispose());
      displays.clear();
    },
  };
}
