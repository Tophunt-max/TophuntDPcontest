/**
 * Pure comment helpers shared by the app's CommentSheet and the blog thread.
 *
 * `mergeComments` is the reason optimistic posting is safe, and its contract is
 * subtle enough that it was worth extracting from CommentSheet.tsx to test:
 * the server stores a comment under the client's own token, so the confirmed row
 * arrives with the SAME id as the placeholder and has to overwrite it. Get that
 * wrong and a reader sees their comment twice — which is indistinguishable from
 * a double-post and invites them to delete "the duplicate".
 */
import { describe, it, expect } from 'vitest';
import {
  mergeComments,
  relativeTime,
  validateCommentDraft,
  MAX_COMMENT_LEN,
} from '@/src/services/comments/commentUtils';

const c = (over: Partial<any>): any => ({
  id: 'c1',
  postId: 'p1',
  userId: 'u1',
  username: 'u1',
  userAvatar: null,
  text: 'hi',
  createdAt: 1000,
  likes: 0,
  ...over,
});

describe('mergeComments', () => {
  it('replaces an optimistic row with the server echo of the same id', () => {
    const optimistic = c({ id: 'token-1', text: 'hello', pending: true });
    const confirmed = c({ id: 'token-1', text: 'hello', likes: 0 });

    const out = mergeComments([optimistic], [confirmed]);

    expect(out).toHaveLength(1);
    expect(out[0].pending).toBe(false);
  });

  it('keeps the optimistic row pending while it is on the EXISTING side', () => {
    // Argument order is load-bearing: `pending: false` is forced on the incoming
    // side only, which is what lets a caller show "Posting…" until the echo.
    const out = mergeComments([c({ id: 'token-1', pending: true })], []);
    expect(out[0].pending).toBe(true);
  });

  it('sorts newest first', () => {
    const out = mergeComments([], [c({ id: 'a', createdAt: 100 }), c({ id: 'b', createdAt: 300 }), c({ id: 'z', createdAt: 200 })]);
    expect(out.map((x) => x.id)).toEqual(['b', 'z', 'a']);
  });

  it('breaks ties on id descending, matching the server keyset order', () => {
    const out = mergeComments([], [c({ id: 'a', createdAt: 500 }), c({ id: 'c', createdAt: 500 }), c({ id: 'b', createdAt: 500 })]);
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('merges an older page into the current list without dropping either', () => {
    const page1 = [c({ id: 'n2', createdAt: 900 }), c({ id: 'n1', createdAt: 800 })];
    const page2 = [c({ id: 'o2', createdAt: 700 }), c({ id: 'o1', createdAt: 600 })];
    expect(mergeComments(page1, page2).map((x) => x.id)).toEqual(['n2', 'n1', 'o2', 'o1']);
  });

  it('lets the incoming row win on conflicting fields (server is authoritative)', () => {
    const stale = c({ id: 'x', likes: 0, likedByMe: true });
    const fresh = c({ id: 'x', likes: 7, likedByMe: false });
    const out = mergeComments([stale], [fresh]);
    expect(out[0]).toMatchObject({ likes: 7, likedByMe: false });
  });
});

describe('validateCommentDraft', () => {
  it('accepts normal text and returns it trimmed', () => {
    const r = validateCommentDraft('  great article  ');
    expect(r).toEqual({ ok: true, text: 'great article', error: null });
  });

  it('rejects empty and whitespace-only drafts', () => {
    expect(validateCommentDraft('').ok).toBe(false);
    expect(validateCommentDraft('   \n  ').ok).toBe(false);
  });

  it('rejects a draft past the server limit, at the same boundary', () => {
    expect(validateCommentDraft('x'.repeat(MAX_COMMENT_LEN)).ok).toBe(true);
    expect(validateCommentDraft('x'.repeat(MAX_COMMENT_LEN + 1)).ok).toBe(false);
  });

  it('measures the TRIMMED length, so trailing whitespace cannot fail a valid comment', () => {
    expect(validateCommentDraft(`${'x'.repeat(MAX_COMMENT_LEN)}     `).ok).toBe(true);
  });
});

describe('relativeTime', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const ago = (ms: number) => relativeTime(NOW - ms, NOW);

  it('reads as "just now" for a fresh comment', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(30_000)).toBe('just now');
  });

  it('clamps a future timestamp instead of saying "in 3 seconds"', () => {
    // Device and server clocks disagree often enough that this happens for real.
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now');
  });

  it('uses singular and plural units correctly', () => {
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(60 * 60_000)).toBe('1 hour ago');
    expect(ago(5 * 60 * 60_000)).toBe('5 hours ago');
    expect(ago(26 * 60 * 60_000)).toBe('1 day ago');
    expect(ago(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });

  it('switches to an absolute date past a month, when an age stops being useful', () => {
    const out = ago(120 * 24 * 60 * 60_000);
    expect(out).not.toMatch(/ago/);
    expect(out).toMatch(/2025/);
  });

  it('returns an empty string for a missing or unusable timestamp', () => {
    expect(relativeTime(undefined, NOW)).toBe('');
    expect(relativeTime(null, NOW)).toBe('');
    expect(relativeTime('not a date', NOW)).toBe('');
    expect(relativeTime(0, NOW)).toBe('');
  });
});
