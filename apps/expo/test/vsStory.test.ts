/**
 * Battle story frame data.
 *
 * The requirement is that BOTH entries appear together, side by side, with a VS
 * tag between them — and that both participants see the same story. The layout
 * itself is two `flex: 1` halves in a row (verifiable by reading
 * `StoryVsFrame.tsx`); what is worth testing is the part that decides WHICH two
 * photos are drawn and in WHAT order.
 */
import { describe, it, expect } from 'vitest';
import { resolveVsFrame } from '@/src/lib/vsStory';

const match = (over: Record<string, any> = {}) => ({
  id: 'm1',
  type: 'photo',
  title: 'Best Smile',
  rewardAmount: 40,
  userA: { uid: 'alice', username: 'alice', mediaUrl: 'alice.jpg', profilePic: 'alice-pfp.jpg' },
  userB: { uid: 'bob', username: 'bob', mediaUrl: 'bob.jpg', profilePic: 'bob-pfp.jpg' },
  ...over,
});

describe('resolveVsFrame', () => {
  it('puts BOTH entries in the frame, one per side', async () => {
    const frame = resolveVsFrame(match())!;

    expect(frame).not.toBeNull();
    expect(frame.left.uri).toBe('alice.jpg');
    expect(frame.right.uri).toBe('bob.jpg');
    // Both usernames are available to label the two halves.
    expect(frame.left.username).toBe('alice');
    expect(frame.right.username).toBe('bob');
    expect(frame.title).toBe('Best Smile');
    expect(frame.prize).toBe(40);
  });

  it('always puts the creator on the left, for every viewer', () => {
    // NOT viewer-relative. Both participants must see the SAME story, so the
    // frame must not mirror itself depending on who is watching — that would
    // quietly turn one story into two.
    const frame = resolveVsFrame(match())!;
    expect(frame.left.uid).toBe('alice'); // userA = creator
    expect(frame.right.uid).toBe('bob'); // userB = joiner
  });

  it('prefers the resized variant when the media zone provides one', () => {
    const frame = resolveVsFrame(
      match({
        userA: { uid: 'alice', username: 'alice', mediaUrl: 'alice.jpg', mediaUrlOptimized: 'alice-1080.jpg' },
        userB: { uid: 'bob', username: 'bob', mediaUrl: 'bob.jpg', mediaUrlOptimized: 'bob-1080.jpg' },
      }),
    )!;
    expect(frame.left.uri).toBe('alice-1080.jpg');
    expect(frame.right.uri).toBe('bob-1080.jpg');
  });

  it('marks a video battle so both sides render a still frame', () => {
    expect(resolveVsFrame(match({ type: 'video' }))!.isVideo).toBe(true);
    expect(resolveVsFrame(match())!.isVideo).toBe(false);
  });

  it('refuses to build a one-sided "VS"', () => {
    // A VS card with a single photo is not what was asked for, so the caller
    // shows the plain single-entry fallback instead of half a battle.
    expect(resolveVsFrame(match({ userB: null }))).toBeNull();
    expect(resolveVsFrame(match({ userA: null }))).toBeNull();
    // A participant present but with no media is equally unusable.
    expect(resolveVsFrame(match({ userB: { uid: 'bob', username: 'bob' } }))).toBeNull();
  });

  it('returns null when the battle itself is unavailable', () => {
    // /read/matches/:id deliberately returns nothing when a participant is
    // blocked by the viewer, so this is a normal path and not an error.
    expect(resolveVsFrame(null)).toBeNull();
    expect(resolveVsFrame(undefined)).toBeNull();
    expect(resolveVsFrame({})).toBeNull();
  });

  it('falls back to sane values for a partially-filled match', () => {
    const frame = resolveVsFrame({
      userA: { uid: 'alice', mediaUrl: 'a.jpg' },
      userB: { uid: 'bob', mediaUrl: 'b.jpg' },
    })!;
    expect(frame.title).toBe('Battle');
    expect(frame.prize).toBe(0);
    expect(frame.left.username).toBe('user');
    expect(frame.left.avatarUri).toBeNull();
  });

  it('never reports a NaN prize', () => {
    expect(resolveVsFrame(match({ rewardAmount: undefined, prizeCoins: undefined }))!.prize).toBe(0);
    expect(resolveVsFrame(match({ rewardAmount: 'oops' }))!.prize).toBe(0);
    expect(resolveVsFrame(match({ rewardAmount: undefined, prizeCoins: 25 }))!.prize).toBe(25);
  });
});
