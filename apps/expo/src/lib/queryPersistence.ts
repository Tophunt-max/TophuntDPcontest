/**
 * Persist selected React Query data so an offline (or slow) start paints the
 * last good profile, explore, leaderboard and rewards screens instead of
 * skeletons. Built on react-query's own `dehydrate` / `hydrate` and the
 * owner-scoped offline store (src/lib/offlineStore.ts); no extra dependency.
 *
 *  - Only allow-listed query roots are saved (PERSISTED_ROOTS). Wallet,
 *    transactions, payments, app control and anything not listed stay memory-only.
 *  - Contact and money fields are removed before saving (stripPrivateFields). A
 *    restored own profile is marked `__offline` so screens can hide the balance
 *    instead of showing a wrong 0 (ProfileScreen hides the wallet card).
 *  - Saved per owner (`u:<uid>` / `guest`); restored only for the same owner.
 *  - Restored data is never "fresh": every mounted query refetches as soon as the
 *    network allows, and the server answer replaces it.
 * Pure module (no react-native import) so the policy is unit-tested directly.
 */
import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from '@tanstack/react-query';
import { DEFAULT_MAX_AGE_MS, loadOffline, offlineGeneration, saveOffline } from './offlineStore';

export const QUERY_SNAPSHOT_NAME = 'queries';
/** Total serialized size kept; newest queries win when over. */
export const MAX_PERSIST_BYTES = 350_000;

/** First element of the query key. Everything else is never written to disk. */
export const PERSISTED_ROOTS = new Set<string>([
  'profile',
  'userPosts',
  'userMatches',
  'userWins',
  'highlights',
  'leaderboard',
  'explore',
  'gamification',
  'match',
  'battle',
  'mutuals',
  'relationship',
  'followRequestCount',
]);

/** Removed at any depth (≤ 4) before saving: contact, identity and money fields. */
export const PRIVATE_FIELDS = new Set<string>([
  'email', 'phone', 'phoneNumber', 'mobile',
  'dob', 'dateOfBirth', 'birthDate',
  // Account balances only: prize / entry-fee amounts on contests are public and stay.
  'Dpcoin', 'dpcoin', 'lockedCoins', 'locked_coins', 'walletBalance', 'withdrawable',
  'fcmToken', 'pushToken', 'deviceToken',
  'upi', 'upiId', 'bank', 'bankAccount', 'pan', 'kyc', 'address',
  'referralCode',
]);

export function isPersistable(query: Pick<Query, 'queryKey' | 'state'>): boolean {
  const root = query.queryKey?.[0];
  return (
    typeof root === 'string' &&
    PERSISTED_ROOTS.has(root) &&
    query.state.status === 'success' &&
    query.state.data !== undefined
  );
}

export function stripPrivateFields(value: any, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => stripPrivateFields(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(k)) continue;
    out[k] = stripPrivateFields(v, depth + 1);
  }
  return out;
}

/** The state to write: allow-listed, filtered, newest first, within the byte cap. */
export function buildSnapshot(client: QueryClient, maxBytes = MAX_PERSIST_BYTES): DehydratedState {
  const state = dehydrate(client, { shouldDehydrateQuery: isPersistable, shouldDehydrateMutation: () => false });
  const sorted = [...state.queries].sort((a, b) => (b.state.dataUpdatedAt || 0) - (a.state.dataUpdatedAt || 0));
  const kept: DehydratedState['queries'] = [];
  let size = 2;
  for (const q of sorted) {
    let data = stripPrivateFields(q.state.data);
    // A profile restored without its balance says so; see ProfileScreen.
    if (q.queryKey[0] === 'profile' && data && typeof data === 'object' && !Array.isArray(data)) data = { ...data, __offline: true };
    // In-flight promises and errors are never persisted.
    const entry = { queryKey: q.queryKey, queryHash: q.queryHash, state: { ...q.state, data, error: null, fetchStatus: 'idle' as const } };
    let json: string;
    try {
      json = JSON.stringify(entry);
    } catch {
      continue; // not serializable
    }
    if (size + json.length > maxBytes) continue;
    size += json.length + 1;
    kept.push(entry as any);
  }
  return { mutations: [], queries: kept };
}

export async function persistQueries(client: QueryClient, owner: string): Promise<boolean> {
  const gen = offlineGeneration();
  return saveOffline(owner, QUERY_SNAPSHOT_NAME, buildSnapshot(client), gen);
}

/**
 * Put `owner`'s saved queries into the cache. Existing newer data is kept
 * (react-query's hydrate only overwrites older data). Restored queries are
 * marked stale so they refetch when used online. Returns how many were restored.
 */
export async function restoreQueries(client: QueryClient, owner: string, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<number> {
  const entry = await loadOffline<DehydratedState>(owner, QUERY_SNAPSHOT_NAME, maxAgeMs);
  const queries = entry?.data?.queries;
  if (!Array.isArray(queries) || queries.length === 0) return 0;
  const safe = queries.filter((q) => typeof q?.queryKey?.[0] === 'string' && PERSISTED_ROOTS.has(q.queryKey[0] as string));
  try {
    hydrate(client, { mutations: [], queries: safe });
  } catch {
    return 0;
  }
  for (const q of safe) client.getQueryCache().find({ queryKey: q.queryKey, exact: true })?.invalidate();
  return safe.length;
}
