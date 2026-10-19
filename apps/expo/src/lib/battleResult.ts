/**
 * What a battle's result IS, derived once from the match payload, so the feed
 * card, the result page and the shared winner card can never disagree.
 *
 * Pure (no React, no network). The authority is the server: `status`,
 * `winnerUid` and the participants' final `votes` are written by settlement
 * (Worker cron.ts resolveMatch / lib/settleDue.ts). This only reads them.
 */
import { hasEnded } from './countdown';
import { matchPrize } from './contestPrize';

export type BattleOutcome =
  /** Voting still open. */
  | 'live'
  /** Waiting for an opponent. */
  | 'waiting'
  /** Deadline passed; the server has not declared the result yet (seconds, normally). */
  | 'pending'
  | 'winner'
  | 'tie'
  /** Cancelled (minimum votes not reached, same-device votes, or removed). */
  | 'voided';

export interface ResultSide {
  uid: string;
  username: string;
  votes: number;
  /** Best still image for the card: the optimised photo, or null for a video entry. */
  photoUrl: string | null;
  /** The raw entry url (a video for video battles). */
  mediaUrl: string | null;
  isVideo: boolean;
  avatarUrl: string | null;
}

export interface BattleResultSummary {
  outcome: BattleOutcome;
  matchId: string;
  title: string;
  winner: ResultSide | null;
  loser: ResultSide | null;
  /** userA / userB as-is, for the tie layout. */
  a: ResultSide | null;
  b: ResultSide | null;
  totalVotes: number;
  margin: number;
  /** Winner's share of the votes, 0–100, rounded. */
  winnerPct: number;
  prize: { kind: 'coins'; coins: number } | { kind: 'product'; title: string; imageUrl: string | null; value: number } | null;
}

function side(p: any, isVideoBattle: boolean): ResultSide | null {
  if (!p || typeof p !== 'object' || !p.uid) return null;
  const isVideo = isVideoBattle || p.mediaType === 'video';
  return {
    uid: String(p.uid),
    username: String(p.username || 'player'),
    votes: Math.max(0, Number(p.votes) || 0),
    photoUrl: isVideo ? null : p.mediaUrlOptimized || p.mediaUrl || null,
    mediaUrl: p.mediaUrl || null,
    isVideo,
    avatarUrl: p.profilePicThumb || p.profilePic || null,
  };
}

/** The outcome alone — cheap enough for every feed card render. */
export function battleOutcome(match: any, nowMs: number = Date.now()): BattleOutcome {
  const status = match?.status;
  if (status === 'cancelled') return 'voided';
  if (status === 'waiting_for_opponent') return 'waiting';
  if (status === 'completed' || status === 'ended') return match?.winnerUid ? 'winner' : 'tie';
  if (status === 'active' && match?.expiresAt != null && hasEnded(match.expiresAt, nowMs)) return 'pending';
  return 'live';
}

export function summarizeResult(match: any, nowMs: number = Date.now()): BattleResultSummary {
  const outcome = battleOutcome(match, nowMs);
  const isVideoBattle = match?.type === 'video';
  const a = side(match?.userA, isVideoBattle);
  const b = side(match?.userB, isVideoBattle);
  const totalVotes = (a?.votes ?? 0) + (b?.votes ?? 0);
  let winner: ResultSide | null = null;
  let loser: ResultSide | null = null;
  if (outcome === 'winner' && a && b) {
    winner = match.winnerUid === a.uid ? a : match.winnerUid === b.uid ? b : null;
    loser = winner === a ? b : winner === b ? a : null;
  }
  const margin = winner && loser ? Math.max(0, winner.votes - loser.votes) : 0;
  const winnerPct = winner && totalVotes > 0 ? Math.round((winner.votes / totalVotes) * 100) : 0;

  // The same resolver the feed card's prize badge uses (`matchPrize`), so the
  // result page can never show a different prize than the card advertised.
  let prize: BattleResultSummary['prize'] = null;
  if (outcome === 'winner') {
    const p = matchPrize(match);
    if (p.type === 'product') {
      prize = { kind: 'product', title: p.product.title, imageUrl: p.product.imageUrl || null, value: Math.max(0, Number(p.product.value) || 0) };
    } else if (p.coins > 0) {
      prize = { kind: 'coins', coins: p.coins };
    }
  }

  return {
    outcome,
    matchId: String(match?.id || ''),
    title: String(match?.title || '').trim() || 'TopHunt Battle',
    winner,
    loser,
    a,
    b,
    totalVotes,
    margin,
    winnerPct,
    prize,
  };
}

export type ViewerRole = 'winner' | 'loser' | 'player' | 'viewer';

/** Who is looking: the winner, the loser, a player in a tie, or anyone else. */
export function viewerRole(s: BattleResultSummary, uid: string | null | undefined): ViewerRole {
  if (!uid) return 'viewer';
  if (s.winner?.uid === uid) return 'winner';
  if (s.loser?.uid === uid) return 'loser';
  if (s.outcome === 'tie' && (s.a?.uid === uid || s.b?.uid === uid)) return 'player';
  return 'viewer';
}

/** The page headline for this viewer. */
export function resultHeadline(s: BattleResultSummary, role: ViewerRole): { title: string; subtitle: string } {
  if (s.outcome === 'tie') {
    return {
      title: "It's a tie! 🤝",
      subtitle: role === 'player' ? 'Barabar ki takkar — entry fee refund ho gayi.' : 'Dono ko barabar votes mile.',
    };
  }
  if (s.outcome !== 'winner' || !s.winner) return { title: 'Result', subtitle: '' };
  const by = s.margin === 1 ? '1 vote' : `${s.margin} votes`;
  switch (role) {
    case 'winner':
      return { title: 'You won! 🏆', subtitle: `Aapne ${by} se battle jeeta. Congratulations!` };
    case 'loser':
      return { title: 'Great fight! 💪', subtitle: `@${s.winner.username} ne ${by} se jeeta. Agla battle aapka!` };
    default:
      return { title: `@${s.winner.username} wins! 🏆`, subtitle: `${by} se jeeta.` };
  }
}

/** `n votes` with the singular. */
export const votesLabel = (n: number) => `${n} ${n === 1 ? 'vote' : 'votes'}`;

/** "1,250" — coin amounts with Indian digit grouping. */
export function coinsLabel(n: number): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString('en-IN');
}

/**
 * The product photo the shareable card may include, or null for the gift-icon
 * fallback.
 *
 * Native capture (view-shot) reads any image. Web capture (html-to-image) can
 * only read images whose host sends CORS for this site, and one unreadable image
 * fails the WHOLE capture (vsNativeModules.web.ts pre-check) — so on web a
 * product image is used only when it is served from the same origin as the
 * entry photo, which the card already depends on. Admins may paste any https
 * product URL, and an arbitrary shop CDN must not cost the user their card.
 */
export function cardSafePrizeImage(prizeUrl: string | null | undefined, entryUrl: string | null | undefined, isWeb: boolean): string | null {
  if (!prizeUrl || typeof prizeUrl !== 'string') return null;
  let prize: URL;
  try {
    prize = new URL(prizeUrl);
  } catch {
    return null;
  }
  if (prize.protocol !== 'https:' && prize.protocol !== 'http:') return null;
  if (!isWeb) return prizeUrl;
  if (!entryUrl) return null;
  try {
    return new URL(entryUrl).origin === prize.origin ? prizeUrl : null;
  } catch {
    return null;
  }
}

/** Share caption for the winner card. */
export function winnerCaption(s: BattleResultSummary, url: string): string {
  if (s.outcome === 'winner' && s.winner) {
    const prize =
      s.prize?.kind === 'coins' ? ` and won ${coinsLabel(s.prize.coins)} Dpcoins 🪙`
      : s.prize?.kind === 'product' ? ` and won ${s.prize.title} 🎁`
      : '';
    return `🏆 @${s.winner.username} won "${s.title}" on TopHunt with ${votesLabel(s.winner.votes)}${prize}! Congratulations 🎉\n${url}`;
  }
  if (s.outcome === 'tie' && s.a && s.b) {
    return `🤝 @${s.a.username} vs @${s.b.username} ended in a tie on TopHunt!\n${url}`;
  }
  return `See the result on TopHunt 👇\n${url}`;
}

/** App route for a battle's result page. */
export function battleResultPath(matchId: string): string {
  return `/battle/${encodeURIComponent(matchId)}/result`;
}

/**
 * When to re-read a battle after its countdown hits zero, in ms after the end.
 * The first read kicks the server's settlement (Worker lib/settleDue.ts); the
 * realtime `match_status` event usually arrives before the second. Bounded: after
 * the last attempt the card waits for the event or the regular safety-net poll.
 */
export const RESULT_REFETCH_DELAYS_MS = [1500, 4000, 8000, 15000, 30000, 60000] as const;

/**
 * Toast for a winner-card share outcome. Never claims an image was sent when
 * only a link was. Null = say nothing (the user dismissed the sheet).
 */
export function winnerShareMessage(
  outcome: string,
): { text: string; tone: 'success' | 'error' | 'info' } | null {
  switch (outcome) {
    case 'shared_image':
      return { text: 'Winner card shared! 🏆', tone: 'success' };
    case 'handed_off_caption_copied':
      return { text: 'Winner card ready — caption copied, paste it in your post', tone: 'success' };
    case 'image_saved':
      return { text: 'Winner card saved — caption copied, ab kahin bhi post karo', tone: 'success' };
    case 'needs_gesture':
      return { text: 'Share dobara tap karo', tone: 'info' };
    case 'shared_link':
      return { text: 'Result link shared', tone: 'success' };
    case 'copied_link':
      return { text: 'Result link copied — paste to share', tone: 'success' };
    case 'image_unsupported':
      return { text: 'Is device par image attach nahi ho sakti — Save image use karo', tone: 'info' };
    case 'failed':
      return { text: 'Share nahi ho paya. Dobara try karo.', tone: 'error' };
    default:
      return null;
  }
}
