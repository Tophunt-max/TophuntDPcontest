/**
 * Every literal `require('./x.png')`-style asset reference in app code must point
 * at a file that exists, with the exact extension.
 *
 * Metro resolves asset requires by exact filename. Swapping `onBordingLight*.png`
 * for `.webp` without updating the `require()` calls passed lint, typecheck and
 * every unit test, then broke `expo export` on main. Only the web-build job
 * caught it, after the commit had landed. This test catches it in `npm test`,
 * which developers run locally and which is much faster than a full export.
 *
 * Scope is deliberately narrow: static string `require()` / `import` of asset
 * extensions only. Dynamic requires and JS module imports are the bundler's job.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['app', 'src', 'components', 'hooks', 'constants', 'assets'];
const SOURCE_EXT = /\.(tsx?|jsx?|mjs)$/;
const ASSET_EXT = 'png|jpe?g|webp|gif|svg|mp4|mp3|wav|m4a|json|lottie|ttf|otf';
const REF = new RegExp(
  `(?:require\\(\\s*|from\\s+|import\\s+)['"]([^'"]+\\.(?:${ASSET_EXT}))['"]`,
  'g',
);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveRef(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return path.join(root, spec.slice(2));
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  return null; // package asset (e.g. a font from node_modules): not ours to check
}

describe('local asset references', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(root, d)));

  it('scans a non-trivial amount of source', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every static asset require/import resolves to an existing file', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(REF)) {
        const target = resolveRef(file, m[1]);
        if (!target) continue;
        checked++;
        if (!fs.existsSync(target)) {
          missing.push(`${path.relative(root, file)} -> ${m[1]}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
