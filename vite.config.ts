import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend/demo",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3008",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "../../dist/frontend",
    emptyOutDir: true
  }
});

