import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri v2 expects a fixed dev port (devUrl in tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
});
