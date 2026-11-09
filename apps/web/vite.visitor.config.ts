import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./visitor", import.meta.url)),
  base: "/visit/",
  plugins: [
    react(),
    {
      name: "visitor-excludes-editor",
      generateBundle() {
        for (const id of this.getModuleIds()) {
          if (/[\\/]editor[\\/]/.test(id)) this.error(`Visitor imports editor code: ${id}`);
        }
      },
    },
  ],
  build: { outDir: "../dist/visitor", emptyOutDir: true },
});
