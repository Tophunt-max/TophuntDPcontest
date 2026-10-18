/**
 * Which feed cards hold a live `match:<id>` subscription.
 *
 * FlatList keeps cards mounted well outside the screen (windowSize), and every
 * mounted PostCard used to open its own socket. Each socket open is a Worker
 * request, a token verify, an account-state read and a billed Durable Object
 * request, and a hibernating DO still holds the connection. Only the cards a person
 * can actually see benefit from live counts, so Home now subscribes the VISIBLE
 * cards plus AHEAD cards below them (so the next card is already live when it
 * scrolls in).
 *
 * A card that leaves the window unsubscribes. The realtime layer keeps the socket
 * for a short linger (SOCKET_LINGER_MS), so scrolling back and forth reuses it, and
 * a card that was away for a long time does one catch-up read when it returns
 * (PostCard LIVE_CATCH_UP_AFTER_MS).
 */
export const LIVE_AHEAD = 1;

/** The ids to keep live, from the viewable rows FlatList reports. Pure. */
export function liveIdsFor(
  viewable: { index: number | null; item: any }[],
  data: readonly any[],
  ahead: number = LIVE_AHEAD,
): Set<string> {
  const ids = new Set<string>();
  let last = -1;
  for (const v of viewable) {
    if (v.item && typeof v.item === 'object' && typeof v.item.id === 'string') ids.add(v.item.id);
    if (typeof v.index === 'number' && v.index > last) last = v.index;
  }
  if (last < 0) return ids; // nothing on screen → nothing to look ahead of
  for (let i = last + 1; i <= last + ahead && i < data.length; i++) {
    const item = data[i];
    if (item && typeof item === 'object' && typeof item.id === 'string') ids.add(item.id);
  }
  return ids;
}

/** Set equality, so Home re-renders only when the live window actually moved. */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Off screen longer than this → one catch-up read when the card becomes live again.
 * A minute: short enough that a battle cancelled while the card was away is caught
 * on return, long enough that scrolling back and forth costs no reads.
 */
export const LIVE_CATCH_UP_AFTER_MS = 60_000;

/**
 * Should a card hold a live `match:<id>` subscription right now?
 *
 * Off-screen cards never do. Guests may only follow LIVE battles (the Worker
 * refuses anything else, lib/wsGuest.ts), so a guest's finished-battle card must
 * not keep retrying a socket it will never get.
 */
export function shouldListen(opts: { liveActive: boolean; signedIn: boolean; status: string | null | undefined }): boolean {
  if (!opts.liveActive) return false;
  return opts.signedIn || opts.status === 'active' || opts.status === 'waiting_for_opponent';
}

/**
 * Does a card that is becoming live need a catch-up read? `notListeningSince` is
 * when it last stopped listening — its MOUNT time if it never listened (FlatList
 * mounts cards well below the screen, and such a card has been deaf since).
 */
export function needsCatchUp(notListeningSince: number | null, now: number = Date.now()): boolean {
  return notListeningSince != null && now - notListeningSince > LIVE_CATCH_UP_AFTER_MS;
}
