#!/usr/bin/env node
/**
 * Post-export gate for the Expo web build.
 *
 * This script used to COPY `seo/worker.js` into `dist/_worker.js`, which meant the
 * SEO edge layer only existed if someone remembered to run this script. Two
 * separate systems did not:
 *
 *   - the Cloudflare Pages build command was `npx expo export --platform web`
 *   - `.github/workflows/ci.yml` ran `npx expo export -p web`
 *
 * So production served a bare SPA shell for every blog post — no per-post title
 * or description, no canonical, and `/sitemap.xml` and `/robots.txt` answering
 * with HTML instead of XML/text. Nothing failed; Google simply got nothing.
 *
 * The worker now lives at `public/_worker.js`, which `expo export` copies into
 * `dist/` on its own (the same way `public/_headers` and `public/_redirects` get
 * there). Installing it is no longer a step that can be skipped.
 *
 * What is left is verification, which is what this file now does:
 *   1. `dist/_worker.js` really is in the output (advanced mode will be on);
 *   2. `dist/_headers` really is in the output;
 *   3. the two copies of the Content-Security-Policy agree.
 *
 * Run automatically by `npm run build`. If a deploy pipeline runs a bare
 * `expo export`, the build still produces a correct deployment — it just skips
 * these assertions, so prefer `npm run build` everywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, '..');
const distDir = resolve(appDir, 'dist');
const workerSrc = resolve(appDir, 'public', '_worker.js');
const workerOut = resolve(distDir, '_worker.js');
const headersOut = resolve(distDir, '_headers');

if (!existsSync(distDir)) {
  fail(
    `dist/ not found: ${distDir}`,
    'Run "expo export -p web" first (or use "npm run build").',
  );
}

if (!existsSync(workerSrc)) {
  fail(
    `public/_worker.js is missing: ${workerSrc}`,
    'This is the SEO edge Worker. Without it the blog has no server-rendered meta,',
    'no sitemap.xml and no robots.txt.',
  );
}

if (!existsSync(workerOut)) {
  fail(
    `dist/_worker.js was not produced by the export.`,
    'public/_worker.js exists, so the export should have copied it. Check that the',
    'Expo web export still copies public/ into dist/.',
  );
}

if (!existsSync(headersOut)) {
  fail(
    `dist/_headers was not produced by the export.`,
    'Without it the static assets ship with no security headers at all.',
  );
}

await assertCspInSync();

console.log('[web] dist/_worker.js + dist/_headers present; CSP in sync');

function fail(...lines) {
  console.error(`\n[web] ${lines[0]}`);
  for (const line of lines.slice(1)) console.error(`[web] ${line}`);
  console.error('');
  process.exit(1);
}

/**
 * The Content-Security-Policy exists in two places and they must agree.
 *
 * `public/_headers` covers the static assets Pages serves itself; the Worker
 * covers the HTML document, which is the only response a document CSP applies to
 * and the one `_headers` provably does NOT reach in advanced mode. Two copies of
 * a security policy drift, and the drift is invisible — a host you forget to add
 * to one of them silently stops being reachable from half the responses, or
 * silently stops being protected.
 *
 * If this fails, copy the policy verbatim between public/_worker.js
 * (`CONTENT_SECURITY_POLICY`) and public/_headers.
 */
async function assertCspInSync() {
  const line = readFileSync(headersOut, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith('content-security-policy:'));
  if (!line) fail('no Content-Security-Policy rule in dist/_headers.');
  const fromHeaders = line.slice(line.indexOf(':') + 1).trim();

  // Import the Worker and read the constant, rather than regex-matching source.
  // It is built by string concatenation, so only evaluating it gives the real value.
  const { CONTENT_SECURITY_POLICY: fromWorker } = await import(`${workerSrc}?t=${Date.now()}`);
  if (!fromWorker) fail('public/_worker.js does not export CONTENT_SECURITY_POLICY.');

  const normalise = (csp) =>
    csp
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join('; ');

  if (normalise(fromHeaders) !== normalise(fromWorker)) {
    console.error('\n[web] Content-Security-Policy drift between public/_worker.js and public/_headers.\n');
    const inWorker = new Set(normalise(fromWorker).split('; '));
    const inHeaders = new Set(normalise(fromHeaders).split('; '));
    for (const d of inWorker) if (!inHeaders.has(d)) console.error(`  only in _worker.js: ${d}`);
    for (const d of inHeaders) if (!inWorker.has(d)) console.error(`  only in _headers:   ${d}`);
    console.error('');
    process.exit(1);
  }
}
