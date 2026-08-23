import { Image } from 'expo-image';
import NetInfo from '@react-native-community/netinfo';

/**
 * Warm the image cache ahead of time so opening a story feels instant.
 *
 * Nothing in the app used to preload anything, so tapping a story started a cold
 * network fetch while the user was already looking at a blank screen. Instagram's
 * "instant" feel is mostly this: the bytes are already on disk by the time you
 * tap.
 *
 * Two guardrails, because preloading spends someone else's data:
 *
 *  - **Metered connections get a much smaller budget.** `isConnectionExpensive`
 *    is used rather than `type === 'cellular'` so metered wifi hotspots are also
 *    respected.
 *  - **Every URL is only ever prefetched once per app session.** These helpers get
 *    called from effects that re-run on scroll and index changes, so without
 *    de-duplication the same request would be re-issued constantly.
 */

/** How many images to warm at once. */
const BUDGET = {
  normal: 6,
  metered: 2,
};

/**
 * URLs already handed to `Image.prefetch` this session.
 *
 * Deliberately unbounded-but-small: it holds URL strings for media the user has
 * plausibly seen, and it is reset on app restart. It intentionally records the
 * URL even when the prefetch fails, so a permanently broken URL is not retried
 * on every render.
 */
const requested = new Set<string>();

async function meteredBudget(): Promise<number> {
  try {
    const state = await NetInfo.fetch();
    if (!state.isConnected) return 0;
    return state.details && 'isConnectionExpensive' in state.details &&
      state.details.isConnectionExpensive
      ? BUDGET.metered
      : BUDGET.normal;
  } catch {
    // Unknown connection — assume the cautious budget.
    return BUDGET.metered;
  }
}

/**
 * Prefetch up to a connection-appropriate number of image URLs.
 *
 * Fire-and-forget: callers do not await this, and failures are swallowed. There
 * is no cancellation API in expo-image, which is the other reason the budget is
 * kept small — an abandoned prefetch cannot be called back.
 */
export async function prefetchImages(
  urls: (string | null | undefined)[],
  options: { budget?: number } = {},
): Promise<void> {
  const fresh = urls.filter(
    (u): u is string => typeof u === 'string' && !!u && !requested.has(u),
  );
  if (!fresh.length) return;

  const budget = options.budget ?? (await meteredBudget());
  if (budget <= 0) return;

  const batch = fresh.slice(0, budget);
  // Mark before awaiting so concurrent callers cannot double-request.
  batch.forEach((u) => requested.add(u));

  try {
    // 'memory-disk' matches what the views render with, so the warmed entry is
    // actually reused instead of being re-decoded from disk.
    await Image.prefetch(batch, { cachePolicy: 'memory-disk' });
  } catch {
    /* best-effort */
  }
}

/** Testing/diagnostics hook — forget what has been prefetched. */
export function resetPrefetchTracking(): void {
  requested.clear();
}
