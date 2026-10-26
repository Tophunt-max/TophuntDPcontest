/**
 * Links from content the app does not write (announcements, blog HTML) open only
 * when they are web or mail links; crash-report context drops identifying keys.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as any).__DEV__ = false;
});
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));

import { safeExternalUrl } from '@/src/lib/safeLink';
import { scrubExtra } from '@/src/lib/reportError';

describe('safeExternalUrl', () => {
  it('allows http, https and mailto', () => {
    expect(safeExternalUrl(' https://tophunt.in/x ')).toBe('https://tophunt.in/x');
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com');
    expect(safeExternalUrl('mailto:help@tophunt.in')).toBe('mailto:help@tophunt.in');
  });

  it('refuses script, intent, app-scheme, data and disguised schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' java\tscript:alert(1)',
      'intent://x#Intent;scheme=evil;end',
      'tophunt://wallet',
      'data:text/html,<script>1</script>',
      '//evil.com',
      '',
      null,
      42,
    ]) {
      expect(safeExternalUrl(bad as any), String(bad)).toBeNull();
    }
  });
});

describe('scrubExtra', () => {
  it('drops identifying keys and non-primitive values, and caps strings', () => {
    const out = scrubExtra({
      screen: 'profile',
      action: 'block',
      targetUserId: 'abc',
      email: 'a@b.c',
      phoneNumber: '+91',
      nested: { a: 1 },
      count: 3,
      long: 'x'.repeat(5000),
    } as any);
    expect(out).toEqual({ screen: 'profile', action: 'block', count: 3, long: 'x'.repeat(1000) });
  });

  it('returns undefined when nothing survives', () => {
    expect(scrubExtra({ uid: 'x' } as any)).toBeUndefined();
    expect(scrubExtra(undefined)).toBeUndefined();
  });
});
