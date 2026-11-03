import { defineConfig } from "vite";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: "src/renderer",
  plugins: [tailwindcss()],
  oxc: { jsx: { runtime: "automatic" } },
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, ".vite/renderer/main_window"),
  },
  server: { host: "127.0.0.1" },
});
