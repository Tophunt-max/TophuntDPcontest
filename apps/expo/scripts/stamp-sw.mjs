#!/usr/bin/env node
/**
 * Fill in dist/sw.js after `expo export -p web`:
 *  - BUILD_ID: a hash of the emitted JS bundle names, so every deploy with new code
 *    gets a new cache (and the old one is deleted on activate);
 *  - PRECACHE: the files an offline start needs (the JS bundles, the Urbanist
 *    fonts, the manifest and its icons). Not the whole `assets/` folder: it holds
 *    ~7 MB of onboarding images and icon fonts most visits never load, and those
 *    are cached on first use instead.
 * Idempotent; fails if the markers are missing so a renamed line cannot silently
 * ship an unversioned worker.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const swPath = join(dist, 'sw.js');
if (!existsSync(swPath)) {
  console.error('stamp-sw: dist/sw.js not found (did expo export copy public/?)');
  process.exit(1);
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const url = (p) => '/' + relative(dist, p).split(sep).join('/');

const bundles = walk(join(dist, '_expo', 'static')).filter((p) => /\.(js|css)$/.test(p)).map(url).sort();
const fonts = walk(join(dist, 'assets')).filter((p) => /Urbanist-[A-Za-z]+\.[0-9a-f]+\.ttf$/.test(p)).map(url).sort();
const extras = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png'].filter((u) =>
  existsSync(join(dist, u)),
);
if (!bundles.length) {
  console.error('stamp-sw: no JS bundles under dist/_expo/static');
  process.exit(1);
}
const precache = [...bundles, ...fonts, ...extras];
const buildId = createHash('sha256').update(bundles.join('\n')).digest('hex').slice(0, 12);

let sw = readFileSync(swPath, 'utf8');
const idLine = /^const BUILD_ID = .*\/\/ @stamp:build-id$/m;
const listLine = /^const PRECACHE = .*\/\/ @stamp:precache$/m;
if (!idLine.test(sw) || !listLine.test(sw)) {
  console.error('stamp-sw: markers not found in dist/sw.js');
  process.exit(1);
}
sw = sw.replace(idLine, `const BUILD_ID = '${buildId}'; // @stamp:build-id`);
sw = sw.replace(listLine, `const PRECACHE = ${JSON.stringify(precache)}; // @stamp:precache`);
writeFileSync(swPath, sw);
console.log(`stamp-sw: build ${buildId}, ${precache.length} files to precache (${bundles.length} bundles, ${fonts.length} fonts)`);
