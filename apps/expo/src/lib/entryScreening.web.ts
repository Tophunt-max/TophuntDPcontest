/**
 * Web entry-photo screening: find QR codes with the browser's `BarcodeDetector`.
 *
 * Available in Chrome/Edge (incl. Android Chrome, where most web users are) and
 * Samsung Internet; absent in Firefox and Safari, where this FAILS OPEN — the
 * report button and the server-side moderation hold remain the backstop.
 */
import { entryScreeningVerdict, type ScreeningVerdict } from './entryScreeningRules';

export async function screenEntryImage(uri: string | null | undefined): Promise<ScreeningVerdict> {
  if (!uri) return { ok: true };
  try {
    const Detector: any = (globalThis as any).BarcodeDetector;
    if (typeof Detector !== 'function' || typeof createImageBitmap !== 'function') return { ok: true };
    const formats: string[] = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : ['qr_code'];
    if (!formats.includes('qr_code')) return { ok: true };
    const blob = await (await fetch(uri)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const found = await new Detector({ formats: ['qr_code'] }).detect(bitmap);
      return entryScreeningVerdict(
        (found || []).map((c: any) => ({ type: c?.format ?? 'qr_code', data: c?.rawValue ?? '' })),
      );
    } finally {
      bitmap.close?.();
    }
  } catch (e) {
    console.warn('[entryScreening] scan unavailable (allowing)', e);
    return { ok: true };
  }
}
