/**
 * The remembered-original policy behind "Adjust photo".
 *
 * Three defects were live in every photo picker in the app, and all three are
 * silent — nothing throws, nothing logs, the option simply is not there:
 *
 *  1. NO WAY BACK IN. `adjust` was only reachable in the instant after picking,
 *     so closing the adjuster left the photo un-adjustable. Recovery meant
 *     re-picking the image, which on the profile screen meant re-opening the
 *     camera.
 *  2. RE-ADJUSTING WOULD COMPOUND. Screens store the CROPPED uri, so the obvious
 *     "Adjust" button re-crops a crop: resolution is lost every pass and the user
 *     can never zoom back out to recover what was cropped away. This is the one
 *     worth pinning hardest, precisely because that implementation *looks* right.
 *  3. CANCEL WAS INDISTINGUISHABLE FROM DONE — both produced "some uri", so a
 *     caller could not tell whether to leave its state alone.
 *
 * `createPhotoAdjustSession` is the React-free half of `useReadjustablePhoto`, so
 * the policy is testable without a DOM, a renderer or a gesture engine. The tests
 * below drive it through the same sequence the hook does, including a fake
 * adjuster, so they assert the *uri the cropper is handed* — which is the thing
 * that regresses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPhotoAdjustSession } from '@/src/lib/photoAdjustSession';

/** Records what the cropper was asked to crop, and lets the test answer. */
function fakeAdjuster() {
  const calls: { uri: string; aspect: number }[] = [];
  let answer: string | null = null;
  return {
    calls,
    /** Next confirm returns this uri; null simulates the user closing it. */
    willReturn(uri: string | null) {
      answer = uri;
    },
    adjust(uri: string, aspect: number): Promise<string | null> {
      calls.push({ uri, aspect });
      return Promise.resolve(answer);
    },
  };
}

/**
 * The exact sequence `useReadjustablePhoto` runs, minus React.
 *
 * Keeping this in one place means a change to the hook's ordering that broke the
 * policy would have to be mirrored here deliberately, rather than slipping past.
 */
function harness(aspect: number) {
  const cropper = fakeAdjuster();
  const session = createPhotoAdjustSession();

  return {
    cropper,
    canReadjust: () => session.source() !== null,
    async adjustPicked(picked: string): Promise<string> {
      session.remember(picked);
      const out = await cropper.adjust(picked, aspect);
      return out ?? picked;
    },
    async readjust(): Promise<string | null> {
      const source = session.source();
      if (!source) return null;
      return cropper.adjust(source, aspect);
    },
    forget: () => session.forget(),
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness(1);
});

describe('picking a photo', () => {
  it('crops the picked uri at the requested aspect', async () => {
    const wide = harness(0.8);
    wide.cropper.willReturn('file://cropped.jpg');

    await expect(wide.adjustPicked('file://original.jpg')).resolves.toBe('file://cropped.jpg');
    expect(wide.cropper.calls).toEqual([{ uri: 'file://original.jpg', aspect: 0.8 }]);
  });

  it('keeps the original when the user closes the adjuster, so picking is never a dead end', async () => {
    h.cropper.willReturn(null);
    await expect(h.adjustPicked('file://original.jpg')).resolves.toBe('file://original.jpg');
  });
});

describe('re-adjusting', () => {
  it('is still offered after the user closes the adjuster — the reported bug', async () => {
    h.cropper.willReturn(null);
    await h.adjustPicked('file://original.jpg');

    // Previously there was no way back in at all.
    expect(h.canReadjust()).toBe(true);

    h.cropper.willReturn('file://cropped.jpg');
    await expect(h.readjust()).resolves.toBe('file://cropped.jpg');
    expect(h.cropper.calls[1]).toEqual({ uri: 'file://original.jpg', aspect: 1 });
  });

  it('always crops the ORIGINAL, never the previous crop', async () => {
    h.cropper.willReturn('file://cropped-1.jpg');
    await h.adjustPicked('file://original.jpg');

    h.cropper.willReturn('file://cropped-2.jpg');
    await h.readjust();
    h.cropper.willReturn('file://cropped-3.jpg');
    await h.readjust();

    // Every crop starts from the original. If any of these were a cropped uri,
    // repeated adjustment would degrade the image and could not be undone.
    expect(h.cropper.calls.map((c) => c.uri)).toEqual([
      'file://original.jpg',
      'file://original.jpg',
      'file://original.jpg',
    ]);
  });

  it('reports a closed adjuster as null so the caller leaves its state alone', async () => {
    h.cropper.willReturn('file://cropped-1.jpg');
    await h.adjustPicked('file://original.jpg');

    h.cropper.willReturn(null);
    // Not the original, and not the previous crop: null. Anything else would make
    // the screen overwrite a good crop with a no-op.
    await expect(h.readjust()).resolves.toBeNull();
  });

  it('does nothing before a photo has been picked', async () => {
    expect(h.canReadjust()).toBe(false);
    // An avatar already on the profile has no original to re-crop from. Opening
    // the adjuster on the stored (already cropped) upload is the compounding case.
    await expect(h.readjust()).resolves.toBeNull();
    expect(h.cropper.calls).toHaveLength(0);
  });

  it('follows the latest pick when the user changes photo', async () => {
    h.cropper.willReturn('file://first-cropped.jpg');
    await h.adjustPicked('file://first.jpg');
    h.cropper.willReturn('file://second-cropped.jpg');
    await h.adjustPicked('file://second.jpg');

    await h.readjust();
    expect(h.cropper.calls[h.cropper.calls.length - 1].uri).toBe('file://second.jpg');
  });
});

describe('removing the photo', () => {
  it('forgets the original', async () => {
    h.cropper.willReturn('file://cropped.jpg');
    await h.adjustPicked('file://original.jpg');
    expect(h.canReadjust()).toBe(true);

    h.forget();

    expect(h.canReadjust()).toBe(false);
    await expect(h.readjust()).resolves.toBeNull();
  });

  it('is re-armed by picking again', async () => {
    h.cropper.willReturn('file://a.jpg');
    await h.adjustPicked('file://original.jpg');
    h.forget();
    expect(h.canReadjust()).toBe(false);

    await h.adjustPicked('file://new.jpg');
    expect(h.canReadjust()).toBe(true);
    await h.readjust();
    expect(h.cropper.calls[h.cropper.calls.length - 1].uri).toBe('file://new.jpg');
  });
});

describe('sessions are independent', () => {
  it('does not share the remembered original between screens', async () => {
    const avatar = harness(1);
    const story = harness(9 / 16);
    avatar.cropper.willReturn('file://avatar-cropped.jpg');
    await avatar.adjustPicked('file://avatar.jpg');

    // The story screen has picked nothing, so it must offer no re-adjust — a
    // shared module-level original would leak the avatar in here.
    expect(story.canReadjust()).toBe(false);
    await expect(story.readjust()).resolves.toBeNull();
  });
});
