import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// The admin panel talks directly to the tophunt-api Cloudflare Worker.
// In dev, /api|/read|/admin|/auth are proxied to the Worker; in production the
// Worker URL is baked in via VITE_API_URL (.env.production / CI build env).
//
// The fallback is the production API on purpose: a build with no VITE_API_URL
// should reach a working backend rather than a hostname that no longer resolves.
const WORKER_URL = process.env.VITE_API_URL ?? "https://api.tophunt.in";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  define: {
    "import.meta.env.VITE_API_URL": JSON.stringify(WORKER_URL),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5000,
    host: "0.0.0.0",
    proxy: {
      "/admin": { target: WORKER_URL, changeOrigin: true, secure: false },
      "/api": { target: WORKER_URL, changeOrigin: true, secure: false },
      "/read": { target: WORKER_URL, changeOrigin: true, secure: false },
      "/auth": { target: WORKER_URL, changeOrigin: true, secure: false },
    },
  },
});
