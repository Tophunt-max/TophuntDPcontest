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

export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'failed';

/**
 * Share a battle as its VS image WITH the caption where the platform allows
 * both, degrading sensibly everywhere else:
 *
 *  - Web + Web Share API with files: image file + caption together.
 *  - Web without it: caption + link via navigator.share, else copy to clipboard.
 *  - Native + a composite image: share the image file (the card already carries
 *    the VS layout, handles and "Vote on tophunt.in" branding); no per-file
 *    caption is possible through expo-sharing, which is a platform limit.
 *  - Native without an image: the caption + link via the OS text share.
 *
 * Never throws — a user-cancelled sheet resolves to 'dismissed'.
 */
export async function shareBattle(opts: { vsImageUrl?: string | null; caption: string; url: string }): Promise<ShareOutcome> {
  const { vsImageUrl, caption, url } = opts;

  if (Platform.OS === 'web') {
    try {
      const nav: any = typeof navigator !== 'undefined' ? navigator : null;
      if (vsImageUrl && nav?.canShare) {
        try {
          const res = await fetch(vsImageUrl);
          const blob = await res.blob();
          const file = new File([blob], 'battle.jpg', { type: blob.type || CARD_MIME });
          if (nav.canShare({ files: [file] })) {
            await nav.share({ files: [file], text: caption, title: 'Share this battle' });
            return 'shared';
          }
        } catch {
          /* fall through to text/clipboard */
        }
      }
      if (nav?.share) {
        await nav.share({ text: caption, url });
        return 'shared';
      }
      await Clipboard.setStringAsync(caption);
      return 'copied';
    } catch {
      return 'dismissed';
    }
  }

  // Native
  try {
    const sharing = getSharing();
    if (vsImageUrl && typeof sharing?.shareAsync === 'function') {
      const available = typeof sharing.isAvailableAsync === 'function' ? await sharing.isAvailableAsync() : true;
      if (available) {
        const local = await localImageFile(vsImageUrl);
        if (local) {
          await sharing.shareAsync(local, { mimeType: CARD_MIME, dialogTitle: 'Share this battle', UTI: 'public.jpeg' });
          return 'shared';
        }
      }
    }
    const result = await RNShare.share({ message: caption, url });
    return result.action === RNShare.dismissedAction ? 'dismissed' : 'shared';
  } catch {
    return 'failed';
  }
}

/**
 * Save the VS image: a real file download on web; on native, hand it to the OS
 * share sheet where "Save image" lives (no expo-media-library dependency, so no
 * native rebuild needed). Returns false when there is no image to save.
 */
export async function downloadBattleImage(vsImageUrl?: string | null): Promise<boolean> {
  if (!vsImageUrl) return false;

  if (Platform.OS === 'web') {
    try {
      const res = await fetch(vsImageUrl);
      const blob = await res.blob();
      if (typeof document === 'undefined') return false;
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = 'battle.jpg';
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
  const local = await localImageFile(vsImageUrl);
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
