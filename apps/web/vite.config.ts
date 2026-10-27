import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assetCataloguePlugin } from "./asset-catalogue-plugin.ts";

export default defineConfig({
  root: fileURLToPath(new URL("./editor", import.meta.url)),
  plugins: [react(), assetCataloguePlugin()],
  build: {
    assetsInlineLimit: 0,
    outDir: "../dist/editor",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "three-core", test: /[\\/]three[\\/]build[\\/]three\.core\.js$/ },
            // Keep React's development diagnostics out of the growing authoring-code chunk
            // Both builds retain the existing per-chunk limit without disabling framework checks
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
