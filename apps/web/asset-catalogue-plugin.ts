import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";

const assetsRoot = fileURLToPath(new URL("../../assets", import.meta.url));
const manifestPath = resolve(assetsRoot, "manifest.json");
// Only these local development samples may enter the browser build
const allowedIds = new Set([
  "audio-ethereal-calm-v1",
  "audio-mystic-harp-v1",
  "audio-calm-piano-v1",
  "audio-mysterious-piano-v1",
  "audio-reflective-piano-v1",
  "audio-classical-piano-v1",
  "audio-octave-piano-loop-v1",
  "audio-museum-hall-v1",
  "audio-museum-hall-conversation-v1",
  "audio-washroom-room-tone-v1",
  "audio-wooden-cabin-at-night-v1",
  "audio-outdoor-restaurant-v1",
  "audio-quiet-crowd-v1",

  "sample-dunes-image-v1",
  "sample-forest-image-v1",
  "sample-sunset-image-v1",
  "sample-valley-image-v1",
  "sample-dunes-video-v1",
  "sample-forest-video-v1",
  "sample-sunset-video-v1",

  "sample-landscape-image-v1",
  "sample-coast-image-v1",
  "sample-coast-video-v1",
  "test-room-v1",
  "test-crate-v1",
  "sample-snowglobe-v1",
  "test-room-module-v1",
  "display-cube-v1",
  "display-full-glass-case-v1",
  "display-half-glass-case-v1",
  "display-one-sided-glass-case-v1",
  "display-rectangle-stand-v1",
  "display-rectangle-panel-v1",
  "display-square-stand-v1",
  "display-square-panel-v1",
  "furniture-modern-bench-1-v1",
  "furniture-modern-bench-2-v1",
]);
type Entry = {
  assetId: string;
  name: string;
  kind: "environment" | "model" | "image" | "video" | "audio";
  file: string;
  sha256: string;
  thumbnail: string | null;
  thumbnailMode?: "generated";
  placement?: "bottom-center";
  displayRole?: "physical" | "digital";
  displayTop?: number;
  displaySurface?: {
    position: readonly [number, number, number];
    rotation: readonly [number, number, number, number];
    width: number;
    height: number;
  };
  access: string;
  category: string;
  durationSeconds?: number;
};

function deliveryPath(value: unknown, extension: RegExp): string {
  if (typeof value !== "string" || isAbsolute(value) || !extension.test(value)) {
    throw new Error("Invalid catalogue delivery path");
  }
  const target = realpathSync(resolve(assetsRoot, value));
  const local = relative(realpathSync(resolve(assetsRoot, "delivery")), target);
  if (local.startsWith("..") || isAbsolute(local)) {
    throw new Error("Catalogue files must stay inside assets/delivery");
  }
  return normalizePath(target);
}

export function assetCataloguePlugin(): Plugin {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error("Unsupported asset manifest");
  }
  const seen = new Set<string>();
  const entries: Entry[] = manifest.assets.filter((entry: Entry) => allowedIds.has(entry.assetId));
  const files = entries.map((entry) => {
    if (
      seen.has(entry.assetId) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      !["environment", "model", "image", "video", "audio"].includes(entry.kind) ||
      entry.access !== "development-only" ||
      typeof entry.category !== "string" ||
      !entry.category.trim() ||
      (entry.placement !== undefined && entry.placement !== "bottom-center") ||
      (entry.thumbnail === null && entry.thumbnailMode !== "generated")
    ) {
      throw new Error("Invalid or non-development catalogue entry: " + entry.assetId);
    }
    // Audio cards use checked duration metadata instead of loading every track for its length
    if (
      entry.kind === "audio" &&
      (!Number.isFinite(entry.durationSeconds) || entry.durationSeconds! <= 0)
    ) {
      throw new Error("Invalid audio duration: " + entry.assetId);
    }
    if (entry.displayRole !== undefined) {
      if (entry.kind !== "model" || !["physical", "digital"].includes(entry.displayRole)) {
        throw new Error("Invalid display role: " + entry.assetId);
      }
      if (
        entry.displayRole === "physical" &&
        (!Number.isFinite(entry.displayTop) || entry.displayTop! < 0)
      ) {
        throw new Error("Invalid display support height: " + entry.assetId);
      }
      if (entry.displayRole === "digital") {
        const surface = entry.displaySurface;
        if (
          !surface ||
          surface.position?.length !== 3 ||
          !surface.position.every(Number.isFinite) ||
          surface.rotation?.length !== 4 ||
          !surface.rotation.every(Number.isFinite) ||
          Math.abs(Math.hypot(...surface.rotation) - 1) > 0.0001 ||
          !Number.isFinite(surface.width) ||
          surface.width <= 0 ||
          !Number.isFinite(surface.height) ||
          surface.height <= 0
        ) {
          throw new Error("Invalid digital display surface: " + entry.assetId);
        }
      }
    }
    seen.add(entry.assetId);
    const extension =
      entry.kind === "image"
        ? /\.(png|jpe?g|webp)$/i
        : entry.kind === "audio"
          ? /\.m4a$/i
          : entry.kind === "video"
            ? /\.(mp4|webm)$/i
            : /\.glb$/i;
    const model = deliveryPath(entry.file, extension);
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      createHash("sha256").update(readFileSync(model)).digest("hex") !== entry.sha256
    ) {
      throw new Error("Catalogue content hash differs: " + entry.assetId);
    }
    return {
      model,
      thumbnail:
        entry.thumbnail === null ? null : deliveryPath(entry.thumbnail, /\.(png|jpe?g|webp|svg)$/i),
    };
  });
  if (seen.size !== allowedIds.size) {
    throw new Error("All approved sample assets must exist in the manifest");
  }
  return {
    name: "local-asset-catalogue",
    config() {
      return {
        server: {
          fs: {
            allow: [
              dirname(fileURLToPath(import.meta.url)),
              ...files.flatMap((file) =>
                file.thumbnail === null ? [file.model] : [file.model, file.thumbnail],
              ),
            ],
          },
        },
      };
    },
    configureServer(server) {
      server.watcher.add(manifestPath);
      server.watcher.on("change", (changed) => {
        if (normalizePath(changed) === normalizePath(manifestPath)) {
          void server.restart();
        }
      });
    },
    resolveId(id) {
      if (id === "virtual:asset-catalogue") {
        return "\0virtual:asset-catalogue";
      }
    },
    load(id) {
      if (id !== "\0virtual:asset-catalogue") {
        return;
      }
      this.addWatchFile(manifestPath);
      const imports = files
        .map(
          (file, index) =>
            "import model" +
            index +
            " from " +
            JSON.stringify(file.model + "?url") +
            ";\n" +
            (file.thumbnail === null
              ? "const thumbnail" + index + " = null;"
              : "import thumbnail" +
                index +
                " from " +
                JSON.stringify(file.thumbnail + "?url") +
                ";"),
        )
        .join("\n");
      const catalogue = entries
        .map(
          (entry, index) =>
            "{id:" +
            JSON.stringify(entry.assetId) +
            ",name:" +
            JSON.stringify(entry.name) +
            ",kind:" +
            JSON.stringify(entry.kind) +
            ",durationSeconds:" +
            JSON.stringify(entry.durationSeconds) +
            ",category:" +
            JSON.stringify(entry.category) +
            ",sha256:" +
            JSON.stringify(entry.sha256) +
            ",url:model" +
            index +
            ",thumbnail:thumbnail" +
            index +
            ",displayRole:" +
            JSON.stringify(entry.displayRole) +
            ",displayTop:" +
            JSON.stringify(entry.displayTop) +
            ",displaySurface:" +
            JSON.stringify(entry.displaySurface) +
            ",placement:" +
            JSON.stringify(entry.placement ?? null) +
            "}",
        )
        .join(",");
      return imports + "\nexport const assets = [" + catalogue + "];";
    },
  };
}
