import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@renderer": path.resolve(__dirname, "src/renderer"),
    },
  },
  root: "src/renderer",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  // Polyfill Node.js globals used by @ai-sdk/provider-utils in browser context
  define: {
    "process.env": JSON.stringify({}),
    "process.version": JSON.stringify("v18.0.0"),
    "process.platform": JSON.stringify("browser"),
  },
  optimizeDeps: {
    include: [
      "ollama-ai-provider",
      "@ai-sdk/provider-utils",
      "@ai-sdk/provider",
    ],
  },
});
