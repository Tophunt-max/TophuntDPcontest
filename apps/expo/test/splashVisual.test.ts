import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('canonical old splash design', () => {
  const visual = read('src/components/system/SplashVisual.tsx');

  it('keeps the old logo geometry, copy and Urbanist typography', () => {
    expect(visual).toContain("width: 140, height: 140, borderRadius: 30");
    expect(visual).toContain('>TopHunt</Text>');
    expect(visual).toContain('>Compete. Vote. Win.</Text>');
    expect(visual).toContain("fontSize: 36, fontFamily: 'Urbanist-Bold'");
    expect(visual).toContain("fontSize: 18, fontFamily: 'Urbanist-Medium'");
  });

  it('keeps the old pulse and eight-dot bottom loader', () => {
    expect(visual).toContain('withSequence(withSpring(1.1), withSpring(1))');
    expect(visual).toContain('Array.from({ length: 8 }');
    expect(visual).toContain("loadingWrapper: { position: 'absolute', bottom: 80 }");
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
