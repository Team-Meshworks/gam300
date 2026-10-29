import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { assetCataloguePlugin } from "./asset-catalogue-plugin.ts";
import { accountDevelopmentServer, unavailableAccountApi } from "./account-dev-server.ts";

export default defineConfig(({ command, mode }) => {
  const webDirectory = fileURLToPath(new URL(".", import.meta.url));
  const accountServer = command === "serve"
    ? accountDevelopmentServer({ ...loadEnv(mode, webDirectory, "SPATIA_"), ...process.env })
    : {};
  return {
  server: accountServer,
  preview: accountServer,
  root: fileURLToPath(new URL("./editor", import.meta.url)),
  plugins: [
    react(),
    assetCataloguePlugin(),
    ...(!accountServer.proxy ? [unavailableAccountApi()] : []),
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
};
});
