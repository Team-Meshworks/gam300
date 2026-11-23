import { cancelStandPlaybackAttempt, playStandVideo } from "../../shared/asset-runtime/stand-video";
import { displaySurface } from "../../shared/asset-runtime/display-surface";
import { createDisplayText } from "../../shared/asset-runtime/display-text";
import { disposeModels } from "../../shared/asset-runtime/ModelCache";
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
  pause?: () => void;
  resume?: () => void;
  setPreview?: (active: boolean) => void;
  toggle?: () => void;
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
    const resolved = displaySurface(asset, content, models.get(asset.id));
    if (!resolved) return;
    const surface = resolved;
    if (content.type === "text") {
      const group = createDisplayText(surface, content, physical, owner.userData.captionAppearance);
      owner.add(group);
      return {
        signature,
        group,
        dispose() {
          group.removeFromParent();
          disposeModels(group);
        },
      };
    }
    const transparent = physical;
    const group = new THREE.Group();
    group.name = "Display content";
    group.position.fromArray(surface.position);
    group.quaternion.fromArray(surface.rotation);
    group.translateZ(0.004);
    owner.add(group);
    const textures = new Set<THREE.Texture>();
    const materials: THREE.MeshBasicMaterial[] = [];
    const geometries: THREE.PlaneGeometry[] = [];
    let disposed = false;
    let video: HTMLVideoElement | undefined;
    let image: HTMLImageElement | undefined;
    let videoReady = false;
    let wantsPlayback = true;
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
    const mediaHeight = surface.height;
    const main = plane(
      surface.width,
      mediaHeight,
      0,
      textCanvas(
        `Loading ${content.type}…`,
        surface.width,
        mediaHeight,
        undefined,
        32,
        transparent,
      ),
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
      video.preload = "auto";
      video.autoplay = true;
      video.playsInline = true;
      video.loop = true;
      video.volume = content.volume;
      video.muted = false;
      video.onloadeddata = () => {
        if (disposed || !video) return;
        videoReady = true;
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        replace(texture, video.videoWidth, video.videoHeight);
        if (wantsPlayback) playStandVideo(video);
      };
      video.onerror = failure;
      video.src = media.url;
      video.load();
    }
    return {
      signature,
      group,
      pause() {
        if (video) {
          cancelStandPlaybackAttempt(video);
          video.pause();
        }
      },
      resume() {
        if (video && videoReady && wantsPlayback) playStandVideo(video);
      },
      setPreview() {
        if (!video) return;
        video.pause();
        wantsPlayback = true;
        if (videoReady) playStandVideo(video);
      },
      toggle() {
        if (!preview || document.hidden || !video || disposed) return;
        if (!video.paused) {
          cancelStandPlaybackAttempt(video);
          wantsPlayback = false;
          video.pause();
        } else {
          wantsPlayback = true;
          video.muted = false;
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
        }
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
          cancelStandPlaybackAttempt(video);
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
      displays.forEach((display) => display.setPreview?.(active));
    },
    pause() {
      displays.forEach((display) => display.pause?.());
    },
    resume() {
      if (!document.hidden) displays.forEach((display) => display.resume?.());
    },
    toggle(id: string) {
      displays.get(id)?.toggle?.();
    },
    dispose() {
      displays.forEach((display) => display.dispose());
      displays.clear();
    },
  };
}
