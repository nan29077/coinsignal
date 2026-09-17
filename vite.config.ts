import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
