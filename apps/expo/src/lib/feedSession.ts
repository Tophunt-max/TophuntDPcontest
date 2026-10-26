/**
 * Where the reader was on Home, so coming back puts them there again.
 *
 * Home lost its place in three ways: switching For You ↔ Following rebuilt the
 * list from the top; the bottom bar pushes a NEW Home screen (`router.push`), and
 * Back can `replace('/home')`, both of which mount Home again from the top. This
 * keeps, per account and tab, the battles already loaded, the paging cursor and
 * the scroll offset, in memory for the app session.
 *
 * - Memory only. After a cold start Home opens at the top (the saved snapshot in
 *   lib/feedSnapshot.ts still paints instantly).
 * - Restored only within MAX_AGE_MS; older than that, the reader gets a fresh feed.
 * - Keyed by account (the snapshot owner key) and cleared on sign-out, so one
 *   account never sees another's list.
 */
export const MAX_AGE_MS = 5 * 60_000;
/** Cards to render up front when restoring deep into a list (bounded: each card holds players). */
export const MAX_RESTORE_RENDER = 20;

export interface FeedSessionState {
  items: any[];
  nextCursor: number | string | null;
  /** Scroll offset in px. */
  offset: number;
  /** First card on screen when it was saved. */
  firstIndex: number;
  savedAt: number;
}

const store = new Map<string, FeedSessionState>();

export function saveFeedSession(key: string, state: Omit<FeedSessionState, 'savedAt'>, now = Date.now()): void {
  if (!state.items.length) {
    store.delete(key);
    return;
  }
  store.set(key, { ...state, savedAt: now });
}

/** The saved state if it is recent enough; it is removed either way (restore once). */
export function takeFeedSession(key: string, now = Date.now()): FeedSessionState | null {
  const s = store.get(key);
  store.delete(key);
  if (!s || now - s.savedAt > MAX_AGE_MS || !s.items.length) return null;
  return s;
}

/** How many cards to render at once so the restored position exists. */
export function restoreRenderCount(s: FeedSessionState | null, fallback: number): number {
  if (!s) return fallback;
  return Math.min(Math.max(fallback, s.firstIndex + 3), MAX_RESTORE_RENDER, Math.max(s.items.length, fallback));
}

/** Drop saved positions: all, or one account's (key prefix `${owner}|`). */
export function clearFeedSessions(owner?: string): void {
  if (owner === undefined) {
    store.clear();
    return;
  }
  for (const k of [...store.keys()]) if (k.startsWith(`${owner}|`)) store.delete(k);
}
