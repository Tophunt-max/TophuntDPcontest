/**
 * Login at the moment of action — the pure parts of the gate.
 */
import { describe, it, expect } from 'vitest';
import { authPromptCopy, loginHref, pathWithQuery } from '@/src/lib/authGate';

describe('authPromptCopy', () => {
  it('names the action that needs an account', () => {
    expect(authPromptCopy('vote').message).toContain('vote in battles');
    expect(authPromptCopy('follow').message).toContain('follow people');
    expect(authPromptCopy('join').message).toContain('enter contests');
    expect(authPromptCopy('message').message).toContain('messages');
    expect(authPromptCopy('wallet').message).toContain('wallet');
  });
});

describe('loginHref', () => {
  it('carries a safe in-app return path', () => {
    expect(loginHref('/battle/m1')).toBe('/auth/login?redirect=%2Fbattle%2Fm1');
    expect(loginHref('/profile?userId=u1')).toBe('/auth/login?redirect=%2Fprofile%3FuserId%3Du1');
  });
  it('drops anything that could leave the app or loop', () => {
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/auth/login', '/splash', '', null, undefined]) {
      expect(loginHref(bad as any)).toBe('/auth/login');
    }
  });
});

describe('pathWithQuery', () => {
  it('keeps real query params and drops dynamic-segment params', () => {
    expect(pathWithQuery('/story/view/u1', { userId: 'u1' }, ['story', 'view', '[userId]'])).toBe('/story/view/u1');
    expect(pathWithQuery('/profile', { userId: 'u1' }, ['profile'])).toBe('/profile?userId=u1');
    expect(pathWithQuery('/contest/video', { matchId: 'm1', mode: 'join' }, ['contest', 'video'])).toBe('/contest/video?matchId=m1&mode=join');
    expect(pathWithQuery('/home', {}, ['home'])).toBe('/home');
  });
});
