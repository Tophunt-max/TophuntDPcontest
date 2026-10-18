/**
 * Repository-wide audit of share entry points.
 *
 * Scans the app source for every call that hands content to a share target and
 * fails when:
 *   - a NEW share sink appears that is not registered below (so it gets audited
 *     instead of quietly reintroducing a single-photo battle share), or
 *   - a battle share surface stops resolving its image through the canonical
 *     resolver, or passes participant media straight into a share sink.
 *
 * This is the guard for the paths that cannot be rendered in a Node test (React
 * components); their logic is covered by vsShareAsset / shareImage tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SINK = /\b(Share\.share|RNShare\.share|shareAsync|navigator\.share|nav\.share|shareImageFile|shareBattleLink|downloadBattleImage|openShareUrl)\s*\(/g;

/** Every file allowed to call a share sink, and what it shares. */
const REGISTRY: Record<string, 'primitive' | 'battle' | 'non-battle'> = {
  'src/lib/share.ts': 'primitive',
  'src/lib/vsNativeModules.web.ts': 'primitive',
  'src/components/share/ShareSheet.tsx': 'battle',
  'app/story/view/[userId].tsx': 'battle',
  'app/contest/joined/index.tsx': 'battle',
  'app/battle/[id]/result.tsx': 'battle', // winner card screenshot, falls back to the canonical VS card
  'app/setting/delete-account.tsx': 'non-battle', // personal data export
  'app/wallet/index.tsx': 'non-battle', // referral invite
  'src/screens/BlogDetailScreen.tsx': 'non-battle', // blog post link
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The argument text of each sink call (balanced parentheses). */
function sinkCalls(src: string): string[] {
  const calls: string[] = [];
  for (const m of src.matchAll(SINK)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    calls.push(src.slice(start, i - 1));
  }
  return calls;
}

const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'src'))];
const withSinks = files
  .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }))
  .filter((f) => sinkCalls(f.src).length > 0);

describe('share entry point audit', () => {
  it('actually finds the share surfaces (the scan is not vacuous)', () => {
    expect(withSinks.map((f) => f.rel).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it('every file that shares is registered and audited', () => {
    const unknown = withSinks.map((f) => f.rel).filter((rel) => !(rel in REGISTRY));
    expect(unknown).toEqual([]);
  });

  it('every battle share surface resolves the canonical VS image', () => {
    for (const f of withSinks.filter((x) => REGISTRY[x.rel] === 'battle')) {
      expect(/resolveBattleShareAsset|useBattleShareAsset/.test(f.src), f.rel).toBe(true);
    }
  });

  it('no share sink is ever handed a participant\'s media or a profile photo', () => {
    for (const f of withSinks) {
      for (const args of sinkCalls(f.src)) {
        expect(/mediaUrl|profilePic|profileImageUrl|avatar|userA|userB|params\./.test(args), `${f.rel}: ${args.slice(0, 80)}`).toBe(false);
      }
    }
  });

  it('the dead placeholder share paths stay gone', () => {
    const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(all).not.toContain('yourapp.link');
    expect(all).not.toMatch(/export (async )?function shareVsCard/);
    expect(all).not.toMatch(/export (async )?function shareBattle\(/);
  });
});
