/**
 * Per-account feature rollout, mirroring the Worker (lib/appControl.ts
 * `inRollout`): the bucket is a stable FNV-1a hash of `${feature}:${uid}`, and
 * `featureRollout[feature]` (0-100, absent = 100) is the percent of signed-in
 * accounts that get the feature. Guests get it only at 100. The server enforces
 * the same rule, so this only keeps the UI honest.
 */
export function rolloutBucket(key: string, uid: string): number {
  let h = 0x811c9dc5;
  const s = `${key}:${uid}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

export function inRollout(config: any, key: string, uid: string | null | undefined): boolean {
  const raw = config?.featureRollout?.[key];
  const pct = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.floor(raw))) : 100;
  if (pct >= 100) return true;
  if (!uid || pct <= 0) return false;
  return rolloutBucket(key, uid) < pct;
}
