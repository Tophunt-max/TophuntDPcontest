#!/usr/bin/env node
/**
 * Post-export step: install the SEO edge Worker into the Expo web build.
 *
 * `expo export -p web` produces a static SPA in `dist/`. Cloudflare Pages runs
 * in "advanced mode" when a `dist/_worker.js` exists — every request is routed
 * to that Worker, which serves static assets via the ASSETS binding and injects
 * per-post SEO meta / sitemap / robots (see ../seo/worker.js).
 *
 * This copies seo/worker.js -> dist/_worker.js. Run automatically by the
 * `build` npm script; safe to run standalone after an export.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, '..');
const src = resolve(appDir, 'seo', 'worker.js');
const distDir = resolve(appDir, 'dist');
const dest = resolve(distDir, '_worker.js');

if (!existsSync(src)) {
  console.error(`[seo] source worker not found: ${src}`);
  process.exit(1);
}

if (!existsSync(distDir)) {
  console.error(
    `[seo] dist/ not found: ${distDir}\n` +
      `[seo] Run "expo export -p web" first (or use "npm run build").`,
  );
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[seo] installed edge Worker -> ${dest}`);
