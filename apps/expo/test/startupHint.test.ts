import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STARTUP_SLOW_HINT_MS, startupHint } from '../src/lib/startupHint';

describe('startup splash hint', () => {
  it('says nothing on a normal fast start', () => {
    expect(startupHint(false, true)).toBeNull();
    expect(startupHint(false, null)).toBeNull();
  });

  it('explains an offline start at once, without any failure wording', () => {
    const t = startupHint(false, false)!;
    expect(t).toMatch(/Internet connection nahi hai/);
    expect(t).not.toMatch(/restore|failed|guest/i);
  });

  it('explains a slow start after a few seconds', () => {
    expect(STARTUP_SLOW_HINT_MS).toBeLessThan(15_000);
    expect(startupHint(true, true)).toMatch(/slow/);
    expect(startupHint(true, null)).toMatch(/slow/);
  });

  it('the restoring splash shows the hint, not the Retry / guest controls', () => {
    const gate = readFileSync(join(__dirname, '../src/components/system/AuthStartupGate.tsx'), 'utf8');
    expect(gate).toContain('if (!failed) return <RestoringSplash />');
    expect(gate).toContain('<SplashVisual hint={useStartupHint()} />');
  });
});
