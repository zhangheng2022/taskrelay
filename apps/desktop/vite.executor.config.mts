import { defineConfig } from "vite";
export default defineConfig({
  build: {
    lib: {
      entry: "src/executor/entry.ts",
      formats: ["cjs"],
      fileName: () => "executor.cjs",
    },
    rollupOptions: {
      external: [
        "sharp",
        /^@browserbasehq\/stagehand(?:\/|$)/,
        /^@langchain\/(?:core|langgraph|langgraph-checkpoint)(?:\/|$)/,
        /^langchain(?:\/|$)/,
        "p-limit",
      ],
      output: { dynamicImportInCjs: true },
    },
  },
});
