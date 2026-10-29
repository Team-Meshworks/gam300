import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { assetCataloguePlugin } from "./asset-catalogue-plugin.ts";

export default defineConfig({
  root: fileURLToPath(new URL("./editor", import.meta.url)),
  plugins: [
    react(),
    assetCataloguePlugin(),
    {
      name: "entry-page-routes",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url && /^\/(landing|login)\/?(?:\?|$)/.test(request.url))
            request.url = "/entry.html";
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url && /^\/(landing|login)\/?(?:\?|$)/.test(request.url))
            request.url = "/entry.html";
          next();
        });
      },
    },
  ],
  build: {
    assetsInlineLimit: 0,
    outDir: "../dist/editor",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        editor: fileURLToPath(new URL("./editor/index.html", import.meta.url)),
        entry: fileURLToPath(new URL("./editor/entry.html", import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [{ name: "three-core", test: /[\\/]three[\\/]build[\\/]three\.core\.js$/ }],
        },
      },
    },
  },
});
