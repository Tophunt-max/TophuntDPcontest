/**
 * Local-first Home feed: a bounded, viewer-scoped snapshot of the first page.
 *
 * ## What this is for
 *
 * Home used to hold its battles only in component state, so every cold start (and
 * every remount of the screen) showed skeletons until `/read/matches` answered. This
 * keeps the last good FIRST PAGE per (viewer, tab) so Home can paint immediately and
 * revalidate in the background — stale-while-revalidate, not offline-first: the
 * snapshot is never treated as authoritative, and the network answer always wins.
 *
 * ## Tiers (see CACHE_POLICY.md)
 *
 *   1. In-memory map (this module) — the current JS session. Makes a Home remount
 *      paint instantly with no DB read.
 *   2. WatermelonDB `feed_snapshots` — survives restarts. At most one row per tab,
 *      for ONE viewer (every write deletes other viewers' rows).
 *   Media bytes are NOT here: items carry URLs only and expo-image / the video cache
 *   own the bytes. `sanitizeFeedItems` strips `data:` URIs and caps the payload.
 *
 * ## Privacy
 *
 *  - Keyed by viewer: `u:<uid>` or `guest`. A read for one owner can never return
 *    another owner's row (the id encodes the owner AND the row's owner is checked).
 *  - Wiped on any account change (app/_layout.tsx calls clearFeedSnapshots), and
 *    the owner's rows are dropped whenever they block/mute someone, so a restart
 *    cannot resurrect a battle the server now filters.
 *  - Contains only what `/read/matches` already returned to this viewer. Wallet
 *    balances, chat and payment data are never part of a feed item.
 *  - A snapshot is not an authorization. Every action from a card still goes to the
 *    Worker, which re-checks everything.
 *
 * ## Freshness
 *
 *  - Rendered only if younger than MAX_RENDER_AGE_MS and in the current FORMAT.
 *  - ALWAYS revalidated after it is painted — even seconds later (a tab bounce),
 *    because PostCard keeps the viewer's own votes/likes in component state and
 *    the snapshot does not see them. Repainting it without a refresh showed a
 *    battle the viewer just voted on as un-voted. Pull-to-refresh always reaches
 *    the network too. The win is the paint, not a skipped request.
 *  - Vote totals / status in a snapshot are a starting point only; PostCard's live
 *    `match:<id>` subscription and the background refresh replace them.
 *  - The cursor saved with a snapshot is NOT used for "load more" until the fresh
 *    page has replaced it (ranking offsets move between requests), see home.tsx.
 */
import type { FeedSnapshotModel } from '@/src/database/models/FeedSnapshotModel';
import { onSocialGraphChange } from './socialGraphVersion';

export type FeedTab = 'foryou' | 'following';
export type FeedCursor = number | string | null;

/** Bump when the stored item shape changes incompatibly; older rows are ignored. */
export const SNAPSHOT_FORMAT = 1;
/** Items kept per snapshot — two app pages; enough to fill the first screens. */
export const MAX_SNAPSHOT_ITEMS = 16;
/** Serialized size cap per snapshot. Real pages are a few KB per item. */
export const MAX_SNAPSHOT_BYTES = 200_000;
/**
 * Older than this, a snapshot is not shown at all. A week, like other apps'
 * offline feeds: it is always revalidated when painted, and battles that ended
 * more than a day ago are dropped at read time (relevantItems), so an old
 * snapshot shrinks to what is still worth showing instead of going blank.
 */
export const MAX_RENDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Format of a snapshot the server has since answered EMPTY for (nobody
 * followed, no live battles). Never painted on a normal start, where the empty
 * answer is the truth; only offered when the network fails and the screen would
 * otherwise be blank (loadOfflineFeed).
 */
export const SUPERSEDED_FORMAT = -SNAPSHOT_FORMAT;
/** A finished battle older than this is no longer feed material. */
const COMPLETED_KEEP_MS = 24 * 60 * 60 * 1000;

export interface FeedSnapshot {
  owner: string;
  tab: FeedTab;
  items: any[];
  nextCursor: FeedCursor;
  fetchedAt: number;
  format: number;
}

// ---------------------------------------------------------------------------
// Pure policy (unit-tested directly)
// ---------------------------------------------------------------------------

/** Viewer identity used in every key. */
export function feedOwnerKey(uid: string | null | undefined): string {
  return uid ? `u:${uid}` : 'guest';
}

export function snapshotId(owner: string, tab: FeedTab): string {
  return `${owner}|${tab}`;
}

/** Strip embedded media bytes. Any `data:` string becomes null; depth-limited. */
function stripInlineMedia(value: any, depth = 0): any {
  if (typeof value === 'string') return value.startsWith('data:') ? null : value;
  if (!value || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.map((v) => stripInlineMedia(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = stripInlineMedia(v, depth + 1);
  return out;
}

/**
 * Make a server page safe and small enough to persist.
 *
 * Drops cancelled battles (PostCard would remove them anyway), battles that ended
 * more than a day ago, duplicates and id-less rows; strips inline media; then trims
 * from the tail until the JSON fits MAX_SNAPSHOT_BYTES.
 */
export function sanitizeFeedItems(items: any[], now = Date.now()): any[] {
  const seen = new Set<string>();
  const kept: any[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    if (raw.status === 'cancelled') continue;
    const expiresAt = Number(raw.expiresAt);
    if (raw.status === 'completed' && Number.isFinite(expiresAt) && expiresAt < now - COMPLETED_KEEP_MS) continue;
    seen.add(raw.id);
    kept.push(stripInlineMedia(raw));
    if (kept.length >= MAX_SNAPSHOT_ITEMS) break;
  }
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_SNAPSHOT_BYTES) kept.pop();
  return kept;
}

/** Drop battles that ended more than a day before `now` (same rule as saving). */
export function relevantItems(items: any[], now = Date.now()): any[] {
  return (Array.isArray(items) ? items : []).filter((m) => {
    const expiresAt = Number(m?.expiresAt);
    return !(Number.isFinite(expiresAt) && expiresAt < now - COMPLETED_KEEP_MS);
  });
}

/** May this snapshot be painted for `owner` right now? */
export function isRenderable(
  snap: FeedSnapshot | null | undefined,
  owner: string,
  now = Date.now(),
  formats: readonly number[] = [SNAPSHOT_FORMAT],
): snap is FeedSnapshot {
  return (
    !!snap &&
    snap.owner === owner &&
    formats.includes(snap.format) &&
    Array.isArray(snap.items) &&
    relevantItems(snap.items, now).length > 0 &&
    now - snap.fetchedAt >= 0 &&
    now - snap.fetchedAt <= MAX_RENDER_AGE_MS
  );
}

/** A renderable snapshot with only its still-relevant battles. */
const trimmed = (snap: FeedSnapshot, now: number): FeedSnapshot => ({ ...snap, items: relevantItems(snap.items, now) });

/**
 * What Home does when a (viewer, tab) is shown.
 *  - 'paint-revalidate' paint it, refresh in the background, page only after refresh
 *  - 'network'          nothing usable: skeletons until the network answers
 * Pull-to-refresh bypasses this and always goes to the network.
 */
export type FeedLoadPlan = 'paint-revalidate' | 'network';
export function planFeedLoad(snap: FeedSnapshot | null | undefined, owner: string, now = Date.now()): FeedLoadPlan {
  return isRenderable(snap, owner, now) ? 'paint-revalidate' : 'network';
}

/**
 * Bumped by every clear. A caller captures it when it STARTS a fetch and passes it
 * to `saveFeedSnapshot`; a save whose fetch began before a clear (a block, a mute,
 * a sign-out) is discarded, so a response computed before the block cannot be
 * persisted after it.
 */
let generation = 0;
export function snapshotGeneration(): number {
  return generation;
}

/** Append a page, dropping ids already shown (offset cursors can overlap). */
export function appendPage(current: any[], page: any[]): any[] {
  const seen = new Set(current.map((m) => m?.id));
  const out = current.slice();
  for (const m of page) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The persistence the policy needs. Swappable so tests run without SQLite. */
export interface SnapshotStore {
  read(id: string): Promise<FeedSnapshot | null>;
  /** Upsert `snap` and delete every row owned by anyone else. */
  write(id: string, snap: FeedSnapshot): Promise<void>;
  /** Delete rows: all of them, one owner's, or one id. */
  remove(filter?: { owner?: string; id?: string }): Promise<void>;
}

function fromModel(r: FeedSnapshotModel): FeedSnapshot | null {
  try {
    const items = JSON.parse(r.items);
    let nextCursor: FeedCursor = null;
    if (r.nextCursor != null && r.nextCursor !== '') {
      const n = Number(r.nextCursor);
      nextCursor = Number.isFinite(n) && String(n) === r.nextCursor ? n : r.nextCursor;
    }
    return { owner: r.owner, tab: r.tab as FeedTab, items, nextCursor, fetchedAt: r.fetchedAt, format: r.format };
  } catch {
    return null;
  }
}

/** WatermelonDB-backed store. Lazily imports the database so tests can avoid it. */
const watermelonStore: SnapshotStore = {
  async read(id) {
    const { database } = await import('@/src/database');
    try {
      const rec = await database.get<FeedSnapshotModel>('feed_snapshots').find(id);
      return fromModel(rec);
    } catch {
      return null; // not found, or the table is missing on a failed migration
    }
  },
  async write(id, snap) {
    const { database } = await import('@/src/database');
    await database.write(async () => {
      const col = database.get<FeedSnapshotModel>('feed_snapshots');
      const all = await col.query().fetch();
      const existing = all.find((r) => r.id === id);
      const assign = (r: FeedSnapshotModel) => {
        r.owner = snap.owner;
        r.tab = snap.tab;
        r.items = JSON.stringify(snap.items);
        r.nextCursor = snap.nextCursor == null ? null : String(snap.nextCursor);
        r.fetchedAt = snap.fetchedAt;
        r.format = snap.format;
      };
      const ops: any[] = all.filter((r) => r.owner !== snap.owner).map((r) => r.prepareDestroyPermanently());
      ops.push(
        existing
          ? existing.prepareUpdate(assign)
          : col.prepareCreate((r) => {
              r._raw.id = id;
              assign(r);
            }),
      );
      await database.batch(...ops);
    });
  },
  async remove(filter) {
    const { database } = await import('@/src/database');
    await database.write(async () => {
      const all = await database.get<FeedSnapshotModel>('feed_snapshots').query().fetch();
      const doomed = all.filter(
        (r) => (!filter?.owner || r.owner === filter.owner) && (!filter?.id || r.id === filter.id),
      );
      if (doomed.length) await database.batch(...doomed.map((r) => r.prepareDestroyPermanently()));
    });
  },
};

let store: SnapshotStore = watermelonStore;
/** Session tier. Same privacy rules as the store; cleared with it. */
const memory = new Map<string, FeedSnapshot>();

/** Test hook: swap the persistent store. */
export function __setSnapshotStoreForTests(s: SnapshotStore | null): void {
  store = s ?? watermelonStore;
  memory.clear();
  resetFeedCacheStats();
}

// ---------------------------------------------------------------------------
// Observability (no PII: counts and durations only)
// ---------------------------------------------------------------------------

export interface FeedCacheStats {
  /** Snapshot painted from session memory. */
  memoryHits: number;
  /** Snapshot painted from the local database. */
  diskHits: number;
  /** No usable snapshot — had to wait for the network. */
  misses: number;
  /** A snapshot was painted and later replaced by a fresh network page. */
  staleRenders: number;
  /** Background refresh failed while cached content stayed on screen. */
  offlineServes: number;
  /** ms from Home mount to first battle on screen in this session (null until then). */
  firstContentMs: number | null;
}

const stats: FeedCacheStats = {
  memoryHits: 0, diskHits: 0, misses: 0, staleRenders: 0, offlineServes: 0, firstContentMs: null,
};

export function getFeedCacheStats(): Readonly<FeedCacheStats> {
  return { ...stats };
}
export function resetFeedCacheStats(): void {
  Object.assign(stats, { memoryHits: 0, diskHits: 0, misses: 0, staleRenders: 0, offlineServes: 0, firstContentMs: null });
}
export function recordFeedEvent(event: 'stale_render' | 'offline_serve'): void {
  if (event === 'stale_render') stats.staleRenders += 1;
  else stats.offlineServes += 1;
}
export function recordFirstContent(ms: number): void {
  if (stats.firstContentMs == null && Number.isFinite(ms) && ms >= 0) stats.firstContentMs = Math.round(ms);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The snapshot Home may paint for (owner, tab), or null. Never throws: a broken
 * local database degrades to the old network-first behaviour.
 */
export async function loadFeedSnapshot(owner: string, tab: FeedTab, now = Date.now()): Promise<FeedSnapshot | null> {
  const id = snapshotId(owner, tab);
  const inMemory = memory.get(id);
  if (isRenderable(inMemory, owner, now)) {
    stats.memoryHits += 1;
    return trimmed(inMemory, now);
  }
  try {
    const fromDisk = await store.read(id);
    if (isRenderable(fromDisk, owner, now)) {
      memory.set(id, fromDisk);
      stats.diskHits += 1;
      return trimmed(fromDisk, now);
    }
  } catch (e) {
    console.warn('[feedSnapshot] read failed (continuing without cache)', e);
  }
  stats.misses += 1;
  return null;
}

/**
 * The last saved battles for a screen that would otherwise be blank because
 * the network failed: a normal snapshot, or one the server later answered empty
 * for (SUPERSEDED_FORMAT). Shown with the "saved battles" notice. Never throws.
 */
export async function loadOfflineFeed(owner: string, tab: FeedTab, now = Date.now()): Promise<FeedSnapshot | null> {
  const id = snapshotId(owner, tab);
  const formats = [SNAPSHOT_FORMAT, SUPERSEDED_FORMAT];
  const inMemory = memory.get(id);
  if (isRenderable(inMemory, owner, now, formats)) return trimmed(inMemory, now);
  try {
    const fromDisk = await store.read(id);
    if (isRenderable(fromDisk, owner, now, formats)) return trimmed(fromDisk, now);
  } catch {
    /* no cache */
  }
  return null;
}

/** Persist a fresh first page. Fire-and-forget safe; never throws. */
export async function saveFeedSnapshot(
  owner: string,
  tab: FeedTab,
  items: any[],
  nextCursor: FeedCursor,
  now = Date.now(),
  startedAtGeneration: number = generation,
): Promise<void> {
  if (startedAtGeneration !== generation) return; // cleared since this fetch began
  const id = snapshotId(owner, tab);
  const clean = sanitizeFeedItems(items, now);
  // Drop the other owners' session entries too, mirroring the store.
  for (const [k, v] of memory) if (v.owner !== owner) memory.delete(k);
  if (clean.length === 0) {
    // An empty answer is a real answer (e.g. nobody followed yet, no live
    // battles): the old snapshot must not be painted on the next start. It is
    // kept as SUPERSEDED, though, so an offline open can still show what was
    // last seen instead of a blank screen (loadOfflineFeed).
    let previous: FeedSnapshot | null = memory.get(id) ?? null;
    memory.delete(id);
    try {
      previous = previous ?? (await store.read(id));
      if (previous && previous.owner === owner && previous.items?.length) {
        if (startedAtGeneration !== generation) return;
        await store.write(id, { ...previous, format: SUPERSEDED_FORMAT });
        if (startedAtGeneration !== generation) await store.remove({ id });
      } else {
        await store.remove({ id });
      }
    } catch {
      /* best-effort */
    }
    return;
  }
  const snap: FeedSnapshot = {
    owner,
    tab,
    items: clean,
    // Kept for completeness only: home.tsx never pages from a cached cursor (see
    // the module comment), it waits for the fresh page's cursor.
    nextCursor,
    fetchedAt: now,
    format: SNAPSHOT_FORMAT,
  };
  memory.set(id, snap);
  try {
    await store.write(id, snap);
    // A clear that ran while this write was queued wins: undo the write.
    if (startedAtGeneration !== generation) {
      memory.delete(id);
      await store.remove({ id });
    }
  } catch (e) {
    console.warn('[feedSnapshot] write failed (continuing)', e);
  }
}

/** Forget snapshots — every owner's (account change), or one owner's. Never throws. */
export async function clearFeedSnapshots(owner?: string): Promise<void> {
  generation += 1;
  if (owner) {
    for (const [k, v] of memory) if (v.owner === owner) memory.delete(k);
  } else {
    memory.clear();
  }
  try {
    await store.remove(owner ? { owner } : undefined);
  } catch (e) {
    console.warn('[feedSnapshot] clear failed (continuing)', e);
  }
}

/**
 * Blocking or muting someone changes what the server will return. Drop the
 * persisted snapshots (they may contain that person's battles) so a cold start
 * cannot paint them before the refresh filters them out. The uid is not known
 * here, so this clears every snapshot — there is only ever one owner's anyway.
 */
onSocialGraphChange(() => {
  void clearFeedSnapshots();
});
