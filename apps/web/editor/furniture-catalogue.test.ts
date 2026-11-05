import { describe, expect, it } from "vitest";
import { assetCataloguePlugin } from "../asset-catalogue-plugin";

describe("furniture catalogue", () => {
  it("delivers both bench models with bottom-center placement", async () => {
    const plugin = assetCataloguePlugin();
    const load = plugin.load;
    if (typeof load !== "function") throw new Error("Expected catalogue loader");
    const code = await load.call({ addWatchFile() {} } as never, "\0virtual:asset-catalogue");
    if (typeof code !== "string") throw new Error("Expected generated catalogue");
    // Evaluate only the generated records, replacing file imports with inert URLs
    const records = code.slice(code.indexOf("export const assets = "));
    const imports = [...code.matchAll(/import model(\d+) from /g)]
      .map(
        ([, index]) =>
          `const model${index} = "model-${index}.glb"; const thumbnail${index} = null;`,
      )
      .join("\n");
    const assets = new Function(imports + records.replace("export const assets =", "return"))();
    expect(
      assets.filter((asset: { id: string }) => asset.id.startsWith("furniture-modern-bench-")),
    ).toEqual([
      expect.objectContaining({
        id: "furniture-modern-bench-1-v1",
        name: "Modern bench 1",
        kind: "model",
        category: "Furniture",
        placement: "bottom-center",
      }),
      expect.objectContaining({
        id: "furniture-modern-bench-2-v1",
        name: "Modern bench 2",
        kind: "model",
        category: "Furniture",
        placement: "bottom-center",
      }),
    ]);
  });
});
