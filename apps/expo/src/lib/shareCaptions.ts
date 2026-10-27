/**
 * Every share caption the app sends, in one place.
 *
 * Captions are written to get a reaction, not just to describe: a hook first
 * line (Telegram shows only that line), what is at stake (score, time left,
 * prize), one clear call to action, the link on its own line (so WhatsApp
 * unfurls it), and the brand hashtags last.
 *
 * Pure (no react-native imports) so it is unit-testable in Node.
 */
import type { BattleResultSummary } from './battleResult';

export const SHARE_HASHTAGS = '#TopHunt #VoteBattleWin';

const handle = (u: unknown, fallback: string) => {
  const s = typeof u === 'string' ? u.trim().replace(/^@+/, '') : '';
  return s ? `@${s}` : fallback;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const inr = (n: number) => Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('en-IN');
const join = (lines: (string | null | undefined | false)[]) => lines.filter((l) => l !== null && l !== undefined && l !== false).join('\n');

/** "2h 15m" / "45m" / "less than a minute" — time left until `endsAt`, or null when over. */
export function timeLeftLabel(endsAt: unknown, now = Date.now()): string | null {
  const end = typeof endsAt === 'number' ? endsAt : endsAt ? Date.parse(String(endsAt)) : NaN;
  if (!Number.isFinite(end) || end <= now) return null;
  const mins = Math.floor((end - now) / 60_000);
  if (mins < 1) return 'less than a minute';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export interface CaptionMatch {
  title?: string | null;
  status?: string | null;
  expiresAt?: string | number | null;
  userA?: { username?: string | null; votes?: number | null } | null;
  userB?: { username?: string | null; votes?: number | null } | null;
}

/** A live (or upcoming) battle: hook, live score, time pressure, vote CTA. */
export function battleCaption(match: CaptionMatch, url: string, now = Date.now()): string {
  const a = handle(match?.userA?.username, 'someone');
  const b = handle(match?.userB?.username, 'a rival');
  const title = (match?.title || '').trim() || 'This battle';
  const va = Math.max(0, Number(match?.userA?.votes) || 0);
  const vb = Math.max(0, Number(match?.userB?.votes) || 0);
  const live = !match?.status || match.status === 'active';
  const left = live ? timeLeftLabel(match?.expiresAt, now) : null;
  const score = live && match?.userB && va + vb > 0 ? `📊 Live score: ${a} ${va} – ${vb} ${b}` : null;
  return join([
    `🔥 ${title}: ${a} 🆚 ${b}`,
    score,
    left ? `⏳ Sirf ${left} baaki!` : null,
    'Kaun jeetega? Tumhara 1 vote result badal sakta hai 🗳️',
    `👉 Vote now on TopHunt: ${url}`,
    '',
    SHARE_HASHTAGS,
  ]);
}

/** The winner / tie card caption. */
export function resultCaption(s: BattleResultSummary, url: string): string {
  const title = (s.title || '').trim() || 'Battle';
  if (s.outcome === 'winner' && s.winner) {
    const w = handle(s.winner.username, 'Winner');
    const prize =
      s.prize?.kind === 'coins' ? `💰 And won ${inr(s.prize.coins)} DP coins 🪙`
      : s.prize?.kind === 'product' ? `🎁 And won ${s.prize.title}!`
      : null;
    const margin = s.loser && s.margin > 0 ? ` — ${handle(s.loser.username, 'rival')} ko ${plural(s.margin, 'vote', 'votes')} se haraya` : '';
    return join([
      `🏆 ${w} ne "${title}" jeet liya on TopHunt! 🎉`,
      `🗳️ ${plural(s.winner.votes, 'vote', 'votes')} ke saath jeet${margin}`,
      prize,
      `Congratulations ${w}! 👏 Ab tumhari baari — photo daalo, battle jeeto, DP coin kamao 💪`,
      `👉 ${url}`,
      '',
      `${SHARE_HASHTAGS} #Winner`,
    ]);
  }
  if (s.outcome === 'tie' && s.a && s.b) {
    const a = handle(s.a.username, 'someone');
    const b = handle(s.b.username, 'a rival');
    return join([
      `🤝 Barabar ki takkar! ${a} vs ${b} ended in a tie on TopHunt!`,
      s.a.votes > 0
        ? `"${title}" — dono ko ${plural(s.a.votes, 'vote', 'votes')}, koi peeche nahi hata 😮`
        : `"${title}" — koi kisi se kam nahi 😮`,
      'Rematch mein kaun jeetega? Tum bhi battle join karo 🔥',
      `👉 ${url}`,
      '',
      SHARE_HASHTAGS,
    ]);
  }
  return join(['🏁 Battle khatam! Dekho kaun jeeta on TopHunt 👇', url, '', SHARE_HASHTAGS]);
}

/** After creating or joining a battle: ask friends for votes / a challenger. */
export function joinedBattleCaption(opts: { contestName: string; joining: boolean; url: string | null }): string {
  const name = (opts.contestName || '').trim() || 'photo';
  return join([
    opts.joining
      ? `⚔️ Maine "${name}" battle join kar li hai on TopHunt!`
      : `🔥 Maine "${name}" battle shuru ki hai on TopHunt!`,
    opts.joining
      ? 'Mujhe jitane ke liye ek vote do 🙏 — har vote count karta hai 🗳️'
      : 'Hai himmat? Mujhe challenge karo aur DP coin jeeto 💰',
    opts.url ? `👉 ${opts.url}` : null,
    '',
    SHARE_HASHTAGS,
  ]);
}

/** "Share link" from the joined screen: a plain vote ask. */
export function voteLinkCaption(contestName: string, url: string): string {
  const name = (contestName || '').trim() || 'photo';
  return join([`🗳️ "${name}" battle mein vote karo on TopHunt!`, 'Har vote count karta hai — abhi support karo 💪', `👉 ${url}`, '', SHARE_HASHTAGS]);
}

/** A normal (non-battle) story. */
export function storyCaption(username: string | null | undefined, url: string): string {
  const who = handle(username, 'someone');
  return join([`👀 ${who} ki TopHunt story dekho!`, 'Photo battles, live voting aur daily rewards — sab ek jagah ✨', `👉 ${url}`, '', SHARE_HASHTAGS]);
}

/** Wallet "Refer & earn". */
export function referralCaption(code: string, url: string | null): string {
  return join([
    '🎁 TopHunt join karo aur free Diamond kamao! 💎',
    '📸 Photo & video battles khelo, vote karo, prizes jeeto 🏆',
    `🔑 Mera referral code: ${code}`,
    url ? `👉 ${url}` : null,
    '',
    SHARE_HASHTAGS,
  ]);
}

/** A blog post. */
export function blogCaption(title: string, url: string): string {
  return join([`📰 ${(title || '').trim() || 'TopHunt Blog'}`, '', 'Poora padho 👇', url, '', '#TopHunt']);
}

/** Settings → Share TopHunt. */
export function appCaption(url: string): string {
  return join([
    '📸 TopHunt pe aao — photo & video battles, live voting aur daily Diamond! 🏆💎',
    'Mere saath join karo aur pehli battle aaj hi jeeto 👇',
    url,
    '',
    SHARE_HASHTAGS,
  ]);
}
