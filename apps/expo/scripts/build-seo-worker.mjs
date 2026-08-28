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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

await assertCspInSync();

mkdirSync(distDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[seo] installed edge Worker -> ${dest}`);

/**
 * The Content-Security-Policy exists in two places and they must agree.
 *
 * `public/_headers` covers the static assets Pages serves itself; the Worker
 * covers the HTML document, which is the only response a document CSP applies
 * to and the one `_headers` provably does NOT reach in advanced mode. Two copies
 * of a security policy drift, and the drift is invisible — a header you forgot to
 * add to one of them just silently stops protecting half the responses, or
 * silently blocks a host on one of them. So it is checked at build time.
 *
 * If this fails, copy the policy verbatim between seo/worker.js
 * (`CONTENT_SECURITY_POLICY`) and public/_headers.
 */
async function assertCspInSync() {
  const headersFile = resolve(distDir, '_headers');
  if (!existsSync(headersFile)) {
    console.error(
      `[seo] dist/_headers not found. public/_headers should have been copied by the export —\n` +
        `[seo] without it the static assets ship with no security headers at all.`,
    );
    process.exit(1);
  }

  const line = readFileSync(headersFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith('content-security-policy:'));
  if (!line) {
    console.error(`[seo] no Content-Security-Policy rule in dist/_headers.`);
    process.exit(1);
  }
  const fromHeaders = line.slice(line.indexOf(':') + 1).trim();

  // Import the Worker and read the constant, rather than regex-matching source.
  // It is built by string concatenation, so only evaluating it gives the real value.
  const { CONTENT_SECURITY_POLICY: fromWorker } = await import(`${src}?t=${Date.now()}`);
  if (!fromWorker) {
    console.error(`[seo] seo/worker.js does not export CONTENT_SECURITY_POLICY.`);
    process.exit(1);
  }

  const normalise = (csp) =>
    csp
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join('; ');

  if (normalise(fromHeaders) !== normalise(fromWorker)) {
    console.error('[seo] Content-Security-Policy drift between seo/worker.js and public/_headers.\n');
    const inWorker = new Set(normalise(fromWorker).split('; '));
    const inHeaders = new Set(normalise(fromHeaders).split('; '));
    for (const d of inWorker) if (!inHeaders.has(d)) console.error(`  only in seo/worker.js:   ${d}`);
    for (const d of inHeaders) if (!inWorker.has(d)) console.error(`  only in public/_headers: ${d}`);
    console.error('');
    process.exit(1);
  }
  console.log('[seo] CSP in sync between seo/worker.js and _headers');
}
