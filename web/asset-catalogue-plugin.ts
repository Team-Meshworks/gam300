import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";

const assetsRoot = fileURLToPath(new URL("../assets", import.meta.url));
const manifestPath = resolve(assetsRoot, "manifest.json");
// Only these local development samples may enter the browser build
const allowedIds = new Set(["test-room-v1", "test-crate-v1", "sample-snowglobe-v1"]);
type Entry = {
  assetId: string;
  name: string;
  kind: "environment" | "model";
  file: string;
  sha256: string;
  thumbnail: string | null;
  thumbnailMode?: "generated";
  placement?: "bottom-center";
  access: string;
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
      !["environment", "model"].includes(entry.kind) ||
      entry.access !== "development-only" ||
      (entry.placement !== undefined && entry.placement !== "bottom-center") ||
      (entry.thumbnail === null && entry.thumbnailMode !== "generated")
    ) {
      throw new Error("Invalid or non-development catalogue entry: " + entry.assetId);
    }
    seen.add(entry.assetId);
    const model = deliveryPath(entry.file, /\.glb$/i);
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      createHash("sha256").update(readFileSync(model)).digest("hex") !== entry.sha256
    ) {
      throw new Error("Catalogue content hash differs: " + entry.assetId);
    }
    return {
      model,
      thumbnail:
        entry.thumbnail === null ? null : deliveryPath(entry.thumbnail, /\.(png|jpe?g|webp)$/i),
    };
  });
  if (seen.size !== allowedIds.size) {
    throw new Error("All three sample assets must exist in the manifest");
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
            ",sha256:" +
            JSON.stringify(entry.sha256) +
            ",url:model" +
            index +
            ",thumbnail:thumbnail" +
            index +
            ",placement:" +
            JSON.stringify(entry.placement ?? null) +
            "}",
        )
        .join(",");
      return imports + "\nexport const assets = [" + catalogue + "];";
    },
  };
}
