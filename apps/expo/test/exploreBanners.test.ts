import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Migration 0064 publishes these exact same-origin URLs. Guard the contract: a
 * renamed/missing/malformed asset must fail CI instead of becoming a broken
 * production carousel after the Worker migrates first.
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'public', 'explore-banners');
const NAMES = [
  'referral.svg',
  'photo-battle.svg',
  'video-battle.svg',
  'trending.svg',
  'leaderboard.svg',
  'coin-store.svg',
];

describe('production Explore banner artwork', () => {
  it('ships the complete six-banner set', () => {
    expect(fs.readdirSync(DIR).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s is a self-contained 1200×500 TopHunt SVG', (name) => {
    const svg = fs.readFileSync(path.join(DIR, name), 'utf8');
    expect(svg).toMatch(/^<svg[^>]+width="1200"[^>]+height="500"[^>]+viewBox="0 0 1200 500"/);
    expect(svg).toContain('TOPHUNT');
    // No executable content, remote image loads or external hrefs in a public asset.
    expect(svg).not.toMatch(/<script|on\w+\s*=|javascript:|<image|xlink:href|href=/i);
    expect(Buffer.byteLength(svg)).toBeLessThan(20_000);
  });
});