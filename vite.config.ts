import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { cpSync, rmSync } from "fs";

function copyPdfCMaps() {
  return {
    name: "copy-pdf-cmaps",
    closeBundle() {
      const source = path.resolve(__dirname, "node_modules/pdfjs-dist/cmaps");
      const target = path.resolve(__dirname, "dist/cmaps");
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), copyPdfCMaps()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
  root: "src/renderer",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("@blocknote") ||
            id.includes("prosemirror-") ||
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("rehype-") ||
            id.includes("unified") ||
            id.includes("katex") ||
            id.includes("@ai-sdk") ||
            id.includes("ai/") ||
            id.includes("@openai") ||
            id.includes("@anthropic-ai")
          ) return "vendor-editor";
          if (id.includes("react-pdf") || id.includes("pdfjs-dist")) return "vendor-pdf";
          if (id.includes("/d3") || id.includes("d3-")) return "vendor-graph";
        },
      },
    },
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
