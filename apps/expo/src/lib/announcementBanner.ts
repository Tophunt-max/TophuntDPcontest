/**
 * Pure decision logic for the admin announcement BANNER.
 *
 * Kept free of any React / React Native / expo-router imports so it can be unit
 * tested in plain Node (see test/announcementBanner.test.ts). The component
 * (components/ui/AnnouncementBanner.tsx) is a thin shell over these helpers.
 */

export interface BannerAnnouncement {
  enabled?: boolean;
  message?: string | null;
  link?: string | null;
}

/** The trimmed banner message, or undefined when there is nothing to show. */
export function bannerMessage(announcement?: BannerAnnouncement | null): string | undefined {
  const m = announcement?.message?.trim();
  return m ? m : undefined;
}

/**
 * The tappable link for the banner, or undefined.
 *
 * The banner's link field is free text (unlike the popup's, which the admin API
 * validates), so only an http(s) URL is treated as tappable — a stray non-URL
 * value must never turn the whole banner into a dead tap target.
 */
export function bannerLink(link?: string | null): string | undefined {
  const l = link?.trim();
  return l && /^https?:\/\/\S/i.test(l) ? l : undefined;
}

/**
 * Whether the banner should render right now.
 *
 * All the reasons it must stay hidden, in one place:
 *  - not on the home screen (it is mounted globally but is a home-only banner),
 *  - the persisted-dismissal state has not hydrated yet (avoids a flash),
 *  - the admin has it disabled or has set no message, or
 *  - the user already dismissed THIS exact message.
 */
export function shouldShowBanner(input: {
  onHome: boolean;
  ready: boolean;
  enabled?: boolean;
  message?: string;
  dismissedMessage: string | null;
}): boolean {
  const { onHome, ready, enabled, message, dismissedMessage } = input;
  if (!onHome || !ready) return false;
  if (!enabled || !message) return false;
  if (dismissedMessage === message) return false;
  return true;
}
