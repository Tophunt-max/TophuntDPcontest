/**
 * Pure comment helpers, shared by the app's CommentSheet and the blog thread.
 *
 * They live in a `.ts` module rather than beside the components that use them so
 * they can be unit-tested: the test environment is plain Node with no React
 * Native transform, so importing a `.tsx` from a test fails outright (same reason
 * `src/lib/cropMath.ts` exists). Every function here is deterministic.
 */
import type { Comment } from './commentService';

/** Server-enforced limit (apps/worker/src/routes/api.ts MAX_COMMENT_LEN). */
export const MAX_COMMENT_LEN = 500;

/**
 * Merge server comments into the current list by id, newest-first.
 *
 * The `pending: false` on the incoming side is the point of this function, not a
 * detail: an optimistic comment is inserted locally under its clientId, which is
 * also the id the server stores, so the confirmed row arrives with the SAME id
 * and must overwrite the placeholder rather than appear next to it. Merging by
 * id is what makes a retried submit (or a realtime bump that races the POST
 * response) idempotent in the UI as well as on the server.
 */
export function mergeComments(existing: Comment[], incoming: Comment[]): Comment[] {
  const map = new Map<string, Comment>();
  for (const c of existing) map.set(c.id, c);
  for (const c of incoming) map.set(c.id, { ...map.get(c.id), ...c, pending: false });
  return Array.from(map.values()).sort((a, b) => {
    const byTime = Number(b.createdAt) - Number(a.createdAt);
    if (byTime !== 0) return byTime;
    // Tie-break on id, descending, mirroring the server's keyset order
    // (`ORDER BY created_at DESC, id DESC`). Without it two comments written in
    // the same millisecond could swap places between renders.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export interface DraftCheck {
  ok: boolean;
  /** Trimmed text, safe to send. Empty when `ok` is false. */
  text: string;
  /** User-facing reason, or null when the draft is fine. */
  error: string | null;
}

/**
 * Validate a comment draft with the same rules the Worker applies, so an
 * over-long or whitespace-only comment is refused before a request is made
 * (and before an optimistic row is inserted that would have to be rolled back).
 *
 * Trimming happens here and the trimmed text is returned, because the server
 * trims too — sending the untrimmed string would mean the optimistic row and the
 * stored row differ in whitespace.
 */
export function validateCommentDraft(raw: string): DraftCheck {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, text: '', error: 'Comment cannot be empty.' };
  if (text.length > MAX_COMMENT_LEN) {
    return { ok: false, text: '', error: `Comment is too long (max ${MAX_COMMENT_LEN} characters).` };
  }
  return { ok: true, text, error: null };
}

/**
 * Long-form relative time for the blog thread: "just now", "5 minutes ago",
 * "3 hours ago", "2 days ago", then an absolute date past a month.
 *
 * The app feed uses a compact form ("5m", "3h") because it sits in a dense list;
 * an article page is a reading context where the abbreviations look like typos.
 * Past ~30 days a relative age stops being informative and the actual date is
 * what a reader wants, so it switches.
 *
 * `nowMs` is injectable purely so this is testable without freezing the clock.
 */
export function relativeTime(ts: unknown, nowMs: number = Date.now()): string {
  const ms = ts instanceof Date ? ts.getTime() : Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const secs = Math.floor((nowMs - ms) / 1000);
  // A clock skew between device and server can put a fresh comment in the
  // future. "in 3 seconds" would be nonsense, so clamp to the present.
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days <= 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
