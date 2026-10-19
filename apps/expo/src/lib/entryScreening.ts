/**
 * Native (Android / iOS) entry-photo screening: find QR codes in the picked image.
 *
 * Uses expo-camera's `scanFromURLAsync` (ML Kit on Android, CIDetector on iOS) on
 * the LOCAL file — no upload, no network. Metro resolves `entryScreening.web.ts`
 * on web instead, where expo-camera has no image scanner.
 *
 * FAILS OPEN: an install without the native module, or a scanner error, lets the
 * photo through. This is a convenience guard against obvious QR / payment
 * screenshots, not the security boundary (reports + the moderation hold are).
 */
import { entryScreeningVerdict, type ScreeningVerdict } from './entryScreeningRules';

export async function screenEntryImage(uri: string | null | undefined): Promise<ScreeningVerdict> {
  if (!uri) return { ok: true };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const camera = require('expo-camera');
    if (typeof camera?.scanFromURLAsync !== 'function') return { ok: true };
    const found = await camera.scanFromURLAsync(uri, ['qr']);
    return entryScreeningVerdict(Array.isArray(found) ? found : []);
  } catch (e) {
    console.warn('[entryScreening] scan unavailable (allowing)', e);
    return { ok: true };
  }
}
