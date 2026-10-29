import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 412, height: 915 }) }));
import { join } from 'node:path';
import { LOGIN_ART_ASPECT, loginArtSize, PHONE_MAX_WIDTH } from '../src/lib/layout';

describe('login art size', () => {
  it('fills the phone column on normal phones (was 60% of it)', () => {
    expect(loginArtSize(412, 915)).toEqual({ width: 364, height: 243 });
    expect(loginArtSize(360, 800)).toEqual({ width: 312, height: 208 });
    expect(loginArtSize(320, 640).width).toBe(272);
  });

  it('never grows past the phone column on tablets and desktop', () => {
    expect(loginArtSize(1440, 1200).width).toBe(PHONE_MAX_WIDTH - 48);
    expect(loginArtSize(820, 1180).width).toBe(PHONE_MAX_WIDTH - 48);
  });

  it('shrinks on short screens so the sign-in buttons stay in view', () => {
    const landscape = loginArtSize(915, 412);
    expect(landscape.height).toBeLessThanOrEqual(Math.round(412 * 0.34));
    expect(loginArtSize(1440, 700).height).toBeLessThanOrEqual(238);
  });

  it('keeps the art undistorted', () => {
    for (const [w, h] of [[412, 915], [915, 412], [1440, 900], [320, 568]]) {
      const s = loginArtSize(w, h);
      expect(Math.abs(s.width / s.height - LOGIN_ART_ASPECT)).toBeLessThan(0.02);
    }
  });

  it('the login screen uses it for both colour schemes', () => {
    const src = readFileSync(join(__dirname, '..', 'app', 'auth', 'login', 'index.tsx'), 'utf8');
    expect(src).toContain('loginArtSize(windowWidth, windowHeight)');
    expect(src).toContain('<Connect_Dark width={art.width} height={art.height} />');
    expect(src).toContain('<Connect_Light width={art.width} height={art.height} />');
  });
});
