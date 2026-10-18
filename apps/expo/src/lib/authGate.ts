/**
 * "Sign in to …" — login at the moment of action, not at the door.
 *
 * Guests browse freely; when they tap something that needs an account, they get
 * a prompt that names the action and, if they accept, a sign-in that returns
 * them to the same post/profile/contest. The action itself is NOT replayed after
 * sign-in: liking, voting, paying an entry fee, publishing or messaging must be a
 * deliberate tap by the signed-in user.
 */
import { sanitizeRedirect } from './postAuthRedirect';

export type GatedAction =
  | 'like'
  | 'comment'
  | 'vote'
  | 'follow'
  | 'bookmark'
  | 'react'
  | 'reply'
  | 'create'
  | 'join'
  | 'message'
  | 'notifications'
  | 'wallet'
  | 'profile'
  | 'report';

const COPY: Record<GatedAction, string> = {
  like: 'like battles',
  comment: 'comment',
  vote: 'vote in battles',
  follow: 'follow people',
  bookmark: 'save battles',
  react: 'react to stories',
  reply: 'reply to stories',
  create: 'create posts and stories',
  join: 'enter contests',
  message: 'send and read messages',
  notifications: 'see your notifications',
  wallet: 'use your wallet',
  profile: 'see your profile',
  report: 'report content',
};

export function authPromptCopy(action: GatedAction): { title: string; message: string } {
  return {
    title: 'Sign in to continue',
    message: `You need a TopHunt account to ${COPY[action]}. It only takes a minute — you'll come right back here.`,
  };
}

/** The sign-in href for a return path; an unsafe return path is dropped, never forwarded. */
export function loginHref(returnTo?: string | null): string {
  const safe = sanitizeRedirect(returnTo ?? null);
  return safe ? `/auth/login?redirect=${encodeURIComponent(safe)}` : '/auth/login';
}

/**
 * `pathname` + query string from Expo Router's pathname, global params and
 * segments. Params that are DYNAMIC SEGMENTS of the route (`[userId]`,
 * `[...rest]`) are already in the pathname and are not repeated.
 */
export function pathWithQuery(
  pathname: string,
  params: Record<string, unknown> = {},
  segments: readonly string[] = [],
): string {
  const dynamic = new Set(
    segments.map((s) => /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(s)?.[1]).filter((x): x is string => !!x),
  );
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (dynamic.has(k)) continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === 'string' && value) query.set(k, value);
  }
  const qs = query.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
