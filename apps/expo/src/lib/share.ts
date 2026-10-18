import { Platform, Share as RNShare, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { getSharing } from '@/src/lib/vsNativeModules';
import { API_BASE_URL } from '@/src/services/api';

/**
 * One correct implementation of "share this battle", used by the share sheet and
 * anywhere else that shares a match.
 *
 * The previous share sheet shipped three bugs at once: it pointed at
 * `https://tophunt.app/battle/<id>` (wrong domain — there is no tophunt.app — and
 * no such route existed), it never attached the head-to-head VS image, and it
 * used a hard-coded caption. Every "platform" button also did the exact same
 * thing (open the OS sheet) with the platform name used only in a toast. This
 * module fixes the data (link + caption + image) and gives the real per-app
 * targets that actually exist.
 */

/**
 * The origin a shared link points at — derived, never hard-coded to one domain.
 *
 * On web this is simply whatever host the app is being served from
 * (`window.location.origin`), so a share link always points back to the same
 * deployment the user is actually on — tophunt.in, a preview host, staging,
 * anything — with nothing to keep in sync.
 *
 * On native there is no browser location, so it takes (in order) an explicit
 * `EXPO_PUBLIC_SHARE_ORIGIN` for the public web host, then falls back to the
 * configured API origin, so the host is still derived from the running
 * deployment rather than guessed.
 *
 * `EXPO_PUBLIC_SHARE_ORIGIN` is SET for every native build profile in eas.json
 * and is not really optional there. Since the API moved to its own hostname
 * (`api.tophunt.in`), the fallback produces `https://api.tophunt.in/battle/<id>`
 * — a host that answers JSON and does not serve the app at all. Before the
 * split, api and web happened to share a host, so the fallback looked fine.
 */
export function shareOrigin(): string {
  if (
    typeof window !== 'undefined' &&
    window.location &&
    window.location.origin &&
    /^https?:/.test(window.location.origin)
  ) {
    return window.location.origin.replace(/\/$/, '');
  }
  const configured = (process.env.EXPO_PUBLIC_SHARE_ORIGIN || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  try {
    return new URL(API_BASE_URL).origin;
  } catch {
    return '';
  }
}

const CARD_MIME = 'image/jpeg';

export interface ShareMatchLike {
  id?: string;
  title?: string | null;
  userA?: { username?: string | null } | null;
  userB?: { username?: string | null } | null;
  vsImageUrl?: string | null;
}

/** Canonical, openable URL for a battle, on whatever host the app is served from. */
export function battleUrl(matchId: string): string {
  return `${shareOrigin()}/battle/${encodeURIComponent(matchId)}`;
}

/** The public result page link: `https://tophunt.in/battle/<id>/result`. */
export function battleResultUrl(matchId: string): string {
  return `${battleUrl(matchId)}/result`;
}

/**
 * Human caption with both handles and the link, e.g.
 * `Best Smile — @alice vs @bob. Vote now on TopHunt 👇\nhttps://tophunt.in/battle/m1`.
 */
export function battleCaption(match: ShareMatchLike, url: string): string {
  const a = match?.userA?.username ? `@${match.userA.username}` : 'someone';
  const b = match?.userB?.username ? `@${match.userB.username}` : 'a rival';
  const title = (match?.title || '').trim() || 'This battle';
  return `${title} — ${a} vs ${b}. Vote now on TopHunt 👇\n${url}`;
}

// ---------------------------------------------------------------------------
// Per-app share targets — all https so they work on web AND open the native app.
// ---------------------------------------------------------------------------

/** wa.me opens WhatsApp on device and web with the text prefilled. */
export function whatsappShareUrl(caption: string): string {
  return `https://wa.me/?text=${encodeURIComponent(caption)}`;
}
/** Telegram share sheet with the link + a short text. */
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
/** X/Twitter web intent — caption already carries the link. */
export function twitterShareUrl(caption: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`;
}
/** Facebook sharer takes only a URL; the OG tags on /battle/:id provide the preview. */
export function facebookShareUrl(url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}

/** A prefilled web share intent for a platform id, or null when it has none. */
export function platformShareUrl(platformId: string, caption: string, url: string): string | null {
  switch (platformId) {
    case 'wa':
      return whatsappShareUrl(caption);
    case 'tg':
      return telegramShareUrl(url, caption.split('\n')[0]);
    case 'tw':
      return twitterShareUrl(caption);
    case 'fb':
      return facebookShareUrl(url);
    // Instagram, Snapchat and Messenger have no reliable prefilled web share —
    // they need the OS share sheet (and, for IG/Snap, an image), so the caller
    // falls back to the native sheet for these.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/**
 * A local `file://` copy of a remote image, for native file sharing.
 *
 * `expo-sharing` (and iOS in general) will only attach a local file, not an
 * http(s) URL, so a remote composite must be fetched down first. Uses
 * expo-image-manipulator (already a dependency) to fetch + re-encode to a temp
 * JPEG, which avoids pulling in expo-file-system. Returns null on any failure.
 */
async function localImageFile(remoteUrl: string): Promise<string | null> {
  try {
    const ref = await ImageManipulator.manipulate(remoteUrl).renderAsync();
    const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
    try { ref.release?.(); } catch { /* released by runtime */ }
    return out.uri;
  } catch (e) {
    console.warn('[share] could not materialise the VS image locally', e);
    return null;
  }
}

/**
 * What actually happened, stated precisely enough that the UI never claims an
 * image was sent when only a link was:
 *
 *  - `shared_image`              — the VS image FILE was shared (with the caption
 *                                   where the platform allows)
 *  - `handed_off_caption_copied` — Android: the image went to the system share
 *                                   sheet. `expo-sharing` cannot report whether
 *                                   the user then picked an app or backed out,
 *                                   and cannot attach text to a file, so the
 *                                   caption was copied for pasting. Counted as an
 *                                   intended share (the platform gives no better
 *                                   signal); worded neutrally.
 *  - `image_saved`               — iOS: the user chose Save Image / Copy / Print
 *                                   etc. — not a share, never counted
 *  - `shared_link` / `copied_link` — text + link only, no image
 *  - `needs_gesture`             — web: the browser refused because the tap's
 *                                   user activation was spent; ask for one more tap
 *  - `image_unsupported`         — this browser/build cannot attach a file
 *  - `dismissed`                 — the user backed out
 *  - `failed`                    — the image could not be obtained or shared
 */
export type ShareOutcome =
  | 'shared_image'
  | 'handed_off_caption_copied'
  | 'image_saved'
  | 'shared_link'
  | 'copied_link'
  | 'needs_gesture'
  | 'image_unsupported'
  | 'dismissed'
  | 'failed';

/** Outcomes that represent a completed share (and so may bump the share count once). */
export function isCompletedShare(outcome: ShareOutcome): boolean {
  return (
    outcome === 'shared_image' ||
    outcome === 'handed_off_caption_copied' ||
    outcome === 'shared_link' ||
    outcome === 'copied_link'
  );
}

/** The canonical image to send: the server's composite (remote) or a local capture. */
export type ShareImageSource = { kind: 'remote'; url: string } | { kind: 'local'; uri: string };

const isAbort = (e: any) => e?.name === 'AbortError' || /abort|cancel/i.test(String(e?.message || ''));

/** True when this browser can attach a FILE to the Web Share API. */
export function canShareFilesOnWeb(): boolean {
  try {
    const nav: any = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
    const probe = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'probe.jpg', { type: CARD_MIME });
    return !!nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Fetch the image into a `File` for the Web Share API, BEFORE the user taps.
 *
 * Safari (and Chrome on some platforms) only honour `navigator.share` inside the
 * user gesture; awaiting a network fetch after the tap can spend that
 * activation. Surfaces prefetch with this as soon as the image is known, so the
 * tap itself calls `share` with no network wait. Null on any failure.
 */
export async function prepareShareFile(source: ShareImageSource): Promise<File | null> {
  try {
    const res = await fetch(source.kind === 'remote' ? source.url : source.uri);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], 'tophunt-battle.jpg', { type: blob.type || CARD_MIME });
  } catch {
    return null;
  }
}

/** iOS activity types that keep the image on the device rather than sharing it. */
const NON_SHARE_ACTIVITY = /SaveToCameraRoll|CopyToPasteboard|Print|AssignToContact|AddToReadingList|SaveToFiles|MarkupAsPDF/i;

/**
 * Share the battle's VS image file. NEVER silently degrades to a link: if the
 * image cannot be obtained or attached, the outcome says so and the caller
 * decides (and tells the user) what to do instead.
 *
 *  - Web: Web Share API with the file + caption, when the browser supports
 *    files; otherwise `image_unsupported`. Pass `file` (from
 *    `prepareShareFile`) to keep the tap's user activation.
 *  - iOS: React Native `Share` with the LOCAL file url and the caption together
 *    (UIActivityViewController attaches both).
 *  - Android: `expo-sharing` with the local file; Android cannot attach text to
 *    a file intent this way, so the caption is copied for the user to paste.
 *
 * Remote images are first materialised as a local file — native share APIs
 * attach files, not http(s) URLs. A `local` source (a capture) is used as-is;
 * the caller owns releasing it.
 */
export async function shareImageFile(opts: {
  source: ShareImageSource;
  caption: string;
  url: string;
  /** Web only: a pre-fetched file, so `share` runs inside the user gesture. */
  file?: File | null;
}): Promise<ShareOutcome> {
  const { source, caption } = opts;

  if (Platform.OS === 'web') {
    const nav: any = typeof navigator !== 'undefined' ? navigator : null;
    if (!canShareFilesOnWeb()) return 'image_unsupported';
    const file = opts.file ?? (await prepareShareFile(source));
    if (!file) return 'failed';
    if (!nav.canShare({ files: [file] })) return 'image_unsupported';
    try {
      await nav.share({ files: [file], text: caption, title: 'Share this battle' });
      return 'shared_image';
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') return 'needs_gesture';
      return isAbort(e) ? 'dismissed' : 'failed';
    }
  }

  const fileUri = source.kind === 'local' ? source.uri : await localImageFile(source.url);
  if (!fileUri) return 'failed';
  try {
    if (Platform.OS === 'ios') {
      const result: any = await RNShare.share({ url: fileUri, message: caption });
      if (result.action === RNShare.dismissedAction) return 'dismissed';
      return result.activityType && NON_SHARE_ACTIVITY.test(String(result.activityType)) ? 'image_saved' : 'shared_image';
    }
    const sharing = getSharing();
    if (typeof sharing?.shareAsync !== 'function') return 'image_unsupported';
    if (typeof sharing.isAvailableAsync === 'function' && !(await sharing.isAvailableAsync())) return 'image_unsupported';
    await Clipboard.setStringAsync(caption).catch(() => undefined);
    await sharing.shareAsync(fileUri, { mimeType: CARD_MIME, dialogTitle: 'Share this battle', UTI: 'public.jpeg' });
    return 'handed_off_caption_copied';
  } catch (e) {
    return isAbort(e) ? 'dismissed' : 'failed';
  }
}

/**
 * Share ONLY the caption + link (no image). Used for battles that have no VS
 * image (still waiting for an opponent, or unavailable), for "Share the link
 * instead", and for sharing the app. Never throws.
 */
export async function shareBattleLink(opts: { caption: string; url: string }): Promise<ShareOutcome> {
  const { caption, url } = opts;
  if (Platform.OS === 'web') {
    const nav: any = typeof navigator !== 'undefined' ? navigator : null;
    if (typeof nav?.share === 'function') {
      try {
        await nav.share({ text: caption, url });
        return 'shared_link';
      } catch (e) {
        if (isAbort(e)) return 'dismissed';
        /* fall through to the clipboard */
      }
    }
    try {
      await Clipboard.setStringAsync(caption);
      return 'copied_link';
    } catch {
      return 'failed';
    }
  }
  try {
    const result = await RNShare.share({ message: caption, url });
    return result.action === RNShare.dismissedAction ? 'dismissed' : 'shared_link';
  } catch {
    return 'failed';
  }
}

/**
 * Save the VS image: a real file download on web; on native, hand it to the OS
 * share sheet where "Save image" lives (no expo-media-library dependency, so no
 * native rebuild needed). Returns false when there is no image to save.
 *
 * Callers pass the SAME canonical url they share (`resolveBattleShareAsset`), so
 * the saved image is the shared image. (On web it is the identical file; on
 * native both paths re-encode the same source into the app's cache directory,
 * which the OS manages — no file-system dependency is added to delete it.)
 */
export async function downloadBattleImage(vsImageUrl?: string | null, fileName = 'tophunt-battle.jpg'): Promise<boolean> {
  if (!vsImageUrl) return false;

  if (Platform.OS === 'web') {
    try {
      const res = await fetch(vsImageUrl);
      if (!res.ok) return false;
      const blob = await res.blob();
      if (typeof document === 'undefined') return false;
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      return true;
    } catch (e) {
      console.warn('[share] web download failed', e);
      return false;
    }
  }

  const sharing = getSharing();
  if (typeof sharing?.shareAsync !== 'function') return false;
  // A capture is already a local file; only remote images need materialising.
  const local = vsImageUrl.startsWith('file:') ? vsImageUrl : await localImageFile(vsImageUrl);
  if (!local) return false;
  try {
    await sharing.shareAsync(local, { mimeType: CARD_MIME, dialogTitle: 'Save this battle', UTI: 'public.jpeg' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a prefilled per-app share URL. Returns false if it could not be opened,
 * so the caller can fall back to the OS share sheet.
 */
export async function openShareUrl(intentUrl: string): Promise<boolean> {
  try {
    // On web, openURL opens a new tab. On native, https share links hand off to
    // the installed app (wa.me → WhatsApp, t.me → Telegram) or the browser.
    await Linking.openURL(intentUrl);
    return true;
  } catch (e) {
    console.warn('[share] could not open share target', e);
    return false;
  }
}

/** Copy the battle link to the clipboard. */
export async function copyBattleLink(url: string): Promise<void> {
  await Clipboard.setStringAsync(url);
}

// ---------------------------------------------------------------------------
// Sharing the APP itself (Settings -> Share TopHunt)
// ---------------------------------------------------------------------------

/**
 * A shareable origin for the app, or null when we do not have one worth sending.
 *
 * `shareOrigin()` has two failure modes that are fine for a battle link (the
 * caller already has a match to fall back on) but not for "share the app", where
 * the URL is the entire payload:
 *
 *  - it can return `''` when there is no browser location and no configured
 *    origin, and
 *  - on native it falls back to the API origin, which since the hostname split is
 *    `https://api.tophunt.in` — a host that answers JSON and does not serve the
 *    app. Inviting a friend to a JSON endpoint is worse than not offering to.
 *
 * Returning null lets the Settings row hide itself rather than share a dead link.
 */
export function appShareOrigin(): string | null {
  const origin = shareOrigin();
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    // Any api.* host serves the API, not the app.
    if (host === 'api.tophunt.in' || host.startsWith('api.')) return null;
  } catch {
    return null;
  }
  return origin;
}

/** True when "Share TopHunt" can produce a link that actually opens the app. */
export function canShareApp(): boolean {
  return appShareOrigin() !== null;
}

/**
 * Share the app itself — a link share, with the same never-throws contract.
 */
export async function shareApp(): Promise<ShareOutcome> {
  const origin = appShareOrigin();
  if (!origin) return 'failed';
  const caption = `Join me on TopHunt — enter photo and video contests and vote on live battles 👇\n${origin}`;
  return shareBattleLink({ caption, url: origin });
}

/**
 * Web fallback when the browser cannot attach a file to a share (most desktop
 * browsers, Firefox): DOWNLOAD the image and copy the caption, so the user still
 * leaves with the actual picture to post — not just a link. Native never needs
 * this (the OS sheet always takes a file). Returns `image_saved` or `failed`.
 */
export async function saveImageAndCopyCaption(source: ShareImageSource, caption: string, fileName = 'tophunt-battle.jpg'): Promise<ShareOutcome> {
  const url = source.kind === 'remote' ? source.url : source.uri;
  const ok = await downloadBattleImage(url, fileName);
  if (!ok) return 'failed';
  await Clipboard.setStringAsync(caption).catch(() => undefined);
  return 'image_saved';
}
