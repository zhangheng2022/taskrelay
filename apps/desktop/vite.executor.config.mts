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
        /^@browserbasehq\/stagehand(?:\/|$)/,
        /^@langchain\/(?:core|langgraph|langgraph-checkpoint)(?:\/|$)/,
      ],
      output: { dynamicImportInCjs: true },
    },
  },
});
