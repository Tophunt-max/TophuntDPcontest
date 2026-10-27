/**
 * Network-aware image quality (Instagram-style), as a pure decision function.
 *
 * Instagram picks image quality from the connection, not just the screen: a
 * slow or metered connection gets lighter images, preloading is cut back, and
 * Settings has "Use less mobile data". This file decides that; the live
 * network/preference plumbing is `src/lib/networkQuality.ts`.
 *
 * Only the sizes that already exist (128 / 320 / 1080, src/lib/imageVariants.ts)
 * are used, so none of this adds Cloudflare transformations: "lighter" means the
 * 320 variant instead of the 1080 one (measured on production: 21-30 KB instead
 * of 128-220 KB for the same onboarding image).
 *
 * Kept free of react-native imports so it runs in plain Node tests.
 */

export type ConnectionType = 'wifi' | 'ethernet' | 'cellular' | 'other' | 'none' | 'unknown';
export type CellularGeneration = '2g' | '3g' | '4g' | '5g' | null;
/** Browser Network Information API `effectiveType`. */
export type EffectiveType = 'slow-2g' | '2g' | '3g' | '4g' | null;

export interface NetworkSnapshot {
  type: ConnectionType;
  generation?: CellularGeneration;
  /** Metered (mobile data, or a hotspot the OS marks as metered). */
  expensive?: boolean;
  /** The OS / browser "data saver" or "Lite mode" flag. */
  saveData?: boolean;
  effectiveType?: EffectiveType;
  /** Estimated downlink, Mbit/s (browser only). */
  downlinkMbps?: number | null;
}

/** The user's choice in Settings › Data saver. */
export type DataSaverMode = 'off' | 'cellular' | 'always';

export type QualityReason = 'data_saver' | 'system_data_saver' | 'slow_network' | 'normal';

export interface ImagePolicy {
  /** Largest variant to request: 320 = light, 1080 = full quality. */
  maxWidth: 320 | 1080;
  /** Warm images ahead of time (stories). */
  prefetch: boolean;
  /** Show a small blurred-up preview while a full-size image loads. */
  preview: boolean;
  /** Why, for the Settings screen. */
  reason: QualityReason;
}

export const FULL_QUALITY: ImagePolicy = { maxWidth: 1080, prefetch: true, preview: false, reason: 'normal' };

const LIGHT = 320 as const;
const FULL = 1080 as const;

/** Below this estimated downlink (Mbit/s) a 1080 image takes seconds. */
export const SLOW_DOWNLINK_MBPS = 1.5;

export function isMetered(net: NetworkSnapshot): boolean {
  return net.type === 'cellular' || !!net.expensive;
}

export function isSlow(net: NetworkSnapshot): boolean {
  if (net.generation === '2g' || net.generation === '3g') return true;
  if (net.effectiveType === 'slow-2g' || net.effectiveType === '2g' || net.effectiveType === '3g') return true;
  if (typeof net.downlinkMbps === 'number' && net.downlinkMbps > 0 && net.downlinkMbps < SLOW_DOWNLINK_MBPS) return true;
  return false;
}

/** Fast and unmetered: worth spending a few KB on a preview. */
function isFastUnmetered(net: NetworkSnapshot): boolean {
  if (isMetered(net) || isSlow(net) || net.saveData) return false;
  return net.type === 'wifi' || net.type === 'ethernet';
}

/**
 * The image policy for a connection and the user's setting. First match wins:
 *
 *  1. Data saver "always"                      -> light, no preload, no preview
 *  2. Data saver "on mobile data" + metered     -> light, no preload, no preview
 *  3. OS / browser data saver (Lite mode)       -> light, no preload, no preview
 *  4. Slow connection (2G/3G, < 1.5 Mbit/s)     -> light, preload kept small elsewhere, no preview
 *  5. Otherwise                                 -> full quality; preview only on fast unmetered wifi
 *
 * Unknown connection details fall through to full quality: guessing "slow" for
 * every phone that cannot report its generation would make the app look worse
 * for most users.
 */
export function imagePolicyFor(net: NetworkSnapshot, mode: DataSaverMode): ImagePolicy {
  if (mode === 'always') return { maxWidth: LIGHT, prefetch: false, preview: false, reason: 'data_saver' };
  if (mode === 'cellular' && isMetered(net)) return { maxWidth: LIGHT, prefetch: false, preview: false, reason: 'data_saver' };
  if (net.saveData) return { maxWidth: LIGHT, prefetch: false, preview: false, reason: 'system_data_saver' };
  if (isSlow(net)) return { maxWidth: LIGHT, prefetch: true, preview: false, reason: 'slow_network' };
  return { maxWidth: FULL, prefetch: true, preview: isFastUnmetered(net), reason: 'normal' };
}

/** A short human label for the current connection (Settings › Data saver). */
export function describeConnection(net: NetworkSnapshot): string {
  if (net.type === 'none') return 'Offline';
  if (net.type === 'wifi') return net.expensive ? 'Wi-Fi (metered)' : 'Wi-Fi';
  if (net.type === 'ethernet') return 'Wired';
  if (net.type === 'cellular') return net.generation ? `Mobile data (${net.generation.toUpperCase()})` : 'Mobile data';
  if (net.effectiveType) return `Network (${net.effectiveType.toUpperCase()})`;
  return 'Unknown';
}

export function parseDataSaverMode(raw: string | null | undefined): DataSaverMode {
  return raw === 'cellular' || raw === 'always' ? raw : 'off';
}
