import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: "esnext",
    // Pixi loads env extensions (browserAll) via dynamic import; use the
    // native dynamic import path (no preload polyfill) to keep the loader
    // machinery minimal on old tablets.
    modulePreload: false,
  },
  server: {
    port: 5173,
  },
});
