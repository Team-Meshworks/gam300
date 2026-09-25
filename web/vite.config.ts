import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assetCataloguePlugin } from "./asset-catalogue-plugin.ts";

export default defineConfig({
  root: fileURLToPath(new URL("./editor", import.meta.url)),
  plugins: [react(), tailwindcss(), assetCataloguePlugin()],
  build: {
    assetsInlineLimit: 0,
    outDir: "../dist/editor",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "three-core", test: /[\\/]three[\\/]build[\\/]three\.core\.js$/ }],
        },
      },
    },
  },
});
