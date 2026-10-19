/**
 * The ONE canonical share asset for a two-player battle, and the rules every
 * share entry point follows to use it.
 *
 * Every battle share path — the feed share sheet (`ShareSheet`), the Story
 * viewer's share button, Save image, the congratulations screen — resolves its
 * image through `resolveBattleShareAsset`, so they all send the same file: the
 * server-rendered VS card (User A left, User B right, VS badge, handles, title,
 * "VOTE ON TOPHUNT.IN"). That is the same object both participants' VS Stories
 * display. A participant's raw entry is never a share asset for a battle.
 *
 * Resolution order:
 *   1. The Worker's `getMatchShareImage` — authoritative. It verifies the stored
 *      card still exists and regenerates it at the same url if it was swept.
 *   2. Only if that call FAILS (network): a url already in hand, but only if it is
 *      provably THIS match's server card (`isCanonicalVsImageUrl`). A feed/story
 *      payload for a different match, a legacy client card, or a participant
 *      photo never qualifies.
 *   3. Only if there is still no image, and only for a PHOTO battle: a capture
 *      of the on-screen `StoryVsFrame`, gated by the caller on the frame's own
 *      capture-ready signal (both photos decoded) — never a timer. Video battles
 *      never capture: a VideoView paints black into a screenshot.
 *
 * Anything else is reported as `preparing` / `waiting_for_opponent` /
 * `unavailable`, and the UI says so — it does not quietly send a link and call it
 * a share, and it never falls back to one participant's photo.
 */
import type { ShareImageSource, ShareOutcome } from './share';

export type ShareImageStatus = 'ready' | 'preparing' | 'waiting_for_opponent' | 'unavailable';

/** Shape of the Worker's `getMatchShareImage` response. */
export interface ShareImageResponse {
  matchId?: string;
  status?: ShareImageStatus;
  url?: string | null;
  kind?: 'photo' | 'video';
  reason?: string;
  /**
   * True when `unavailable` is the server's RENDERER failing (not a refusal):
   * the client may draw its own card instead of telling the user there is none.
   */
  retryable?: boolean;
}

export type BattleShareAsset =
  | { status: 'ready'; matchId: string; source: ShareImageSource; origin: 'server' | 'known' | 'capture' }
  | { status: 'preparing' | 'waiting_for_opponent' | 'unavailable'; matchId: string; reason?: string };

/**
 * True only for THIS match's server-rendered card:
 * `<media base>/vs-cards/battles/<matchId>-v<N>.jpg`. The match id is part of the
 * key, so a url carried over from another match can never pass.
 */
export function isCanonicalVsImageUrl(url: unknown, matchId: string): url is string {
  if (typeof url !== 'string' || !matchId) return false;
  const escaped = matchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https://[^/]+/(?:media/)?vs-cards/battles/${escaped}-v\\d+\\.jpg$`).test(url);
}

/**
 * A failure to REACH the server (offline, timeout, 5xx), as opposed to an
 * answer. `callApi` raises `ApiCallError` with an HTTP `status` for answers.
 */
function isTransportError(e: unknown): boolean {
  const status = (e as any)?.status;
  if (typeof status === 'number') return status >= 500;
  const code = String((e as any)?.code || '');
  if (code && !/unavailable|deadline-exceeded|internal/.test(code)) return false;
  return true;
}

export async function resolveBattleShareAsset(
  matchId: string,
  opts: {
    fetchShareImage: (matchId: string) => Promise<ShareImageResponse>;
    /** A url already in hand (e.g. the VS Story's media). Used only if the server call fails. */
    knownUrl?: string | null;
    /** On-screen frame capture; return null unless the frame reported capture-ready. */
    capture?: () => Promise<string | null>;
    /**
     * Allow `capture` for VIDEO battles. Only for captures that draw stills
     * (posters) themselves — a screenshot of a VideoView is black.
     */
    captureVideo?: boolean;
  },
): Promise<BattleShareAsset> {
  let status: Exclude<ShareImageStatus, 'ready'> = 'unavailable';
  let reason: string | undefined;
  let kind: 'photo' | 'video' | undefined;
  let retryable = false;
  try {
    const res = await opts.fetchShareImage(matchId);
    if (res?.matchId && res.matchId !== matchId) {
      // An answer about a different battle must never be shared as this one.
      status = 'unavailable';
      reason = 'mismatch';
    } else {
      kind = res?.kind;
      if (res?.status === 'ready' && isCanonicalVsImageUrl(res.url, matchId)) {
        return { status: 'ready', matchId, source: { kind: 'remote', url: res.url }, origin: 'server' };
      }
      status = res?.status && res.status !== 'ready' ? res.status : 'unavailable';
      reason = res?.reason ?? (res?.status === 'ready' ? 'invalid_url' : undefined);
      retryable = status === 'unavailable' && res?.retryable === true;
    }
  } catch (e) {
    if (!isTransportError(e)) {
      // The server ANSWERED and refused (403 blocked viewer, 429, 4xx). That is
      // final: no cached url, no capture.
      const http = Number((e as any)?.status);
      return { status: 'unavailable', matchId, reason: http === 403 ? 'forbidden' : http === 429 ? 'rate_limited' : 'refused' };
    }
    if (isCanonicalVsImageUrl(opts.knownUrl, matchId)) {
      return { status: 'ready', matchId, source: { kind: 'remote', url: opts.knownUrl }, origin: 'known' };
    }
    status = 'unavailable';
    reason = 'network';
  }

  // Capture only when the image is merely LATE (still preparing, the server
  // could not be reached, or its renderer failed) — never to work around a refusal such as a cancelled
  // battle, a blocked pair, a removed participant or untrusted media.
  // A failing server RENDERER (`retryable`) is lateness too, not a refusal.
  const captureAllowed = status === 'preparing' || reason === 'network' || retryable;
  if (opts.capture && (kind !== 'video' || opts.captureVideo) && captureAllowed) {
    let uri: string | null = null;
    try {
      uri = await opts.capture();
    } catch {
      uri = null;
    }
    if (uri) return { status: 'ready', matchId, source: { kind: 'local', uri }, origin: 'capture' };
  }
  return { status, matchId, reason };
}

// ---------------------------------------------------------------------------
// Per-platform routing
// ---------------------------------------------------------------------------

export type SharePlatformId = 'wa' | 'ms' | 'fb' | 'ig' | 'tw' | 'tg' | 'sc';

/**
 * How a platform button shares, given what is possible right now:
 *
 *  - `image_sheet` — send the VS image file through the OS / Web Share sheet
 *                    (the user picks the app there). The only way to put a FILE
 *                    into WhatsApp, Messenger, Instagram, Telegram or Snapchat
 *                    without app-specific native SDKs.
 *  - `link_intent` — open the app's prefilled web intent. Text/link only: these
 *                    intents cannot carry a file (X, Facebook always; WhatsApp and
 *                    Telegram when no image can be attached).
 *  - `link_sheet`  — text/link through the share sheet (no intent exists and no
 *                    image can be attached).
 *  - `wait`        — the image is still being prepared; image-first apps wait
 *                    instead of silently sending a link.
 */
export type PlatformShareMode = 'image_sheet' | 'link_intent' | 'link_sheet' | 'wait';

export function platformShareMode(
  platformId: SharePlatformId | string,
  ctx: { isWeb: boolean; assetStatus: ShareImageStatus | 'loading'; webCanShareFiles: boolean },
): PlatformShareMode {
  // These intents only ever take a URL/text.
  if (platformId === 'tw' || platformId === 'fb') return 'link_intent';
  const canAttach = !ctx.isWeb || ctx.webCanShareFiles;
  if (ctx.assetStatus === 'ready' && canAttach) return 'image_sheet';
  if ((ctx.assetStatus === 'preparing' || ctx.assetStatus === 'loading') && canAttach) return 'wait';
  // No image possible (waiting battle, unavailable, or a browser without file
  // sharing): the supported link behaviour, clearly labelled as a link.
  return platformId === 'wa' || platformId === 'tg' ? 'link_intent' : 'link_sheet';
}

// ---------------------------------------------------------------------------
// Share counting
// ---------------------------------------------------------------------------

/**
 * Counts an intended share ONCE per share session (one sheet opening, one Story
 * share tap), however many fallbacks, retries or callbacks follow. Opening the
 * sheet, a dismissal, a failure or a Save image never count.
 */
export function createShareCounter(bump: () => Promise<unknown>) {
  let counted = false;
  return {
    record(outcome: ShareOutcome | 'intent_opened' | 'dm_sent'): boolean {
      const completed =
        outcome === 'intent_opened' ||
        outcome === 'dm_sent' ||
        outcome === 'shared_image' ||
        outcome === 'handed_off_caption_copied' ||
        outcome === 'shared_link' ||
        outcome === 'copied_link';
      if (!completed || counted) return false;
      counted = true;
      void bump().catch(() => undefined);
      return true;
    },
    reset() {
      counted = false;
    },
  };
}

/** The toast a share outcome may truthfully show. Null = say nothing. */
export function shareOutcomeMessage(outcome: ShareOutcome | 'intent_opened'): { text: string; tone: 'success' | 'error' | 'info' } | null {
  switch (outcome) {
    case 'shared_image':
      return { text: 'VS image shared!', tone: 'success' };
    case 'handed_off_caption_copied':
      return { text: 'VS image sent to the share sheet — caption copied, paste it in your post', tone: 'success' };
    case 'image_saved':
      return { text: 'VS image saved', tone: 'success' };
    case 'needs_gesture':
      return { text: 'Tap Share again to send the VS image', tone: 'info' };
    case 'shared_link':
      return { text: 'Battle link shared', tone: 'success' };
    case 'copied_link':
      return { text: 'Battle link copied — paste to share', tone: 'success' };
    case 'intent_opened':
      return { text: 'Opened with the battle link', tone: 'info' };
    case 'image_unsupported':
      return { text: 'This device can’t attach images here — use Save image, or share the link', tone: 'info' };
    case 'failed':
      return { text: 'Couldn’t share the VS image. Please try again.', tone: 'error' };
    case 'dismissed':
    default:
      return null;
  }
}
