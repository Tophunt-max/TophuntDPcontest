import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('canonical old splash design', () => {
  const visual = read('src/components/system/SplashVisual.tsx');

  it('shows the splash.webp wordmark, the tagline and Urbanist typography', () => {
    expect(visual).toContain("require('../../../assets/images/splash.webp')");
    expect(visual).toContain('accessibilityLabel="TopHunt"');
    expect(visual).toContain('>Compete. Vote. Win.</Text>');
    expect(visual).toContain("fontSize: 18, fontFamily: 'Urbanist-Medium'");
    // An admin-configured splash image keeps the old square card.
    expect(visual).toMatch(/customLogo: \{\s*width: 140,\s*height: 140,\s*borderRadius: 30/);
  });

  it('animates from session time, so the gate -> routed splash hand-off does not restart', () => {
    expect(visual).toContain('let sessionStart: number | null = null');
    expect(visual).toContain('useFrameCallback');
    expect(visual).not.toContain('withSpring'); // no spring overshoot / jerky pulse
    expect(visual).toContain('useReduceMotion()');
  });

  it('keeps the eight-dot bottom loader', () => {
    expect(visual).toContain('Array.from({ length: 8 }');
    expect(visual).toContain("loadingWrapper: { position: 'absolute', bottom: 80 }");
  });

  it('native splash matches the in-app splash background and logo', () => {
    const cfg = JSON.parse(read('app.json'));
    const plugin = cfg.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-splash-screen')[1];
    expect(plugin.image).toBe('./assets/images/splash-icon.png');
    expect(plugin.backgroundColor).toBe('#F9F9FB');
    expect(plugin.dark.backgroundColor).toBe('#0F0F13');
  });

  it('is the only splash visual used by both startup stages', () => {
    const gate = read('src/components/system/AuthStartupGate.tsx');
    const routed = read('app/splash.tsx');
    expect(gate).toContain('<SplashVisual');
    expect(routed).toContain('<SplashVisual');
    expect(gate).not.toContain('session restore ho raha');
    expect(routed).not.toContain('session restore ho raha');
  });
});
