import { defineConfig, type Plugin } from "vite";
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

// Identifies this build, so a tab left open across a deploy can tell it is
// stale (src/lib/updateCheck.ts). The commit on Cloudflare Pages; otherwise a
// timestamp, which is unique per local build.
const BUILD_ID = (process.env.CF_PAGES_COMMIT_SHA || "").slice(0, 12) || `local-${Date.now().toString(36)}`;

/** Writes dist/version.json, which `_headers` serves uncached. */
function buildVersionFile(): Plugin {
  return {
    name: "tophunt-build-version",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ buildId: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), buildVersionFile()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  define: {
    "import.meta.env.VITE_API_URL": JSON.stringify(WORKER_URL),
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(BUILD_ID),
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
