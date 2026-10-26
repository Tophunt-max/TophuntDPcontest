/**
 * Lay a pending (not yet confirmed) like over what the server last said.
 *
 * Without this, a battle liked offline showed as unliked again as soon as the
 * feed refetched or the card caught up, even though the like was still queued
 * and would be applied. The count moves by one only when the pending state
 * differs from the server's, so it is never applied twice.
 */
export function overlayLike(
  serverLiked: boolean,
  serverCount: number,
  pending: { liked: boolean } | undefined,
): { liked: boolean; count: number } {
  const count = Math.max(0, Number(serverCount) || 0);
  if (!pending || pending.liked === serverLiked) return { liked: serverLiked, count };
  return { liked: pending.liked, count: Math.max(0, count + (pending.liked ? 1 : -1)) };
}

export function overlayFlag(serverValue: boolean, pending: boolean | undefined): boolean {
  return typeof pending === 'boolean' ? pending : serverValue;
}
