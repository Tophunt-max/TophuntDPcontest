/**
 * What a battle entry photo may NOT contain, decided from the barcodes found in it.
 *
 * Battles are judged on a person's photo. A QR code in the entry is never that,
 * and in practice it is a payment QR ("scan to pay") — a scam vector aimed at
 * voters — or a screenshot of something else entirely. So any QR code blocks the
 * entry; a UPI / payment payload gets the more specific message.
 *
 * Pure: the platform scanners (entryScreening.ts / .web.ts) only report what
 * they found. This is a client-side guard — the server-side backstop is the
 * report button and the moderation hold (Worker migration 0060).
 */
export interface FoundCode {
  type?: string | null;
  data?: string | null;
}

export type ScreeningVerdict =
  | { ok: true }
  | { ok: false; reason: 'payment_qr' | 'qr_code'; message: string };

const PAYMENT_RE = /^(upi:|upi%3a)|paytm|phonepe|gpay|googlepay|bhim|pay\?pa=|[?&]pa=[^&]+@|razorpay\.me|rzp\.io/i;

export function entryScreeningVerdict(codes: readonly FoundCode[] | null | undefined): ScreeningVerdict {
  const qrs = (codes ?? []).filter((c) => !c?.type || /qr/i.test(String(c.type)));
  if (qrs.length === 0) return { ok: true };
  if (qrs.some((c) => PAYMENT_RE.test(String(c?.data ?? '')))) {
    return {
      ok: false,
      reason: 'payment_qr',
      message: 'Payment QR code wali photo allowed nahi hai. Battle ke liye apni asli photo upload karein.',
    };
  }
  return {
    ok: false,
    reason: 'qr_code',
    message: 'QR code / screenshot allowed nahi hai. Battle ke liye apni asli photo upload karein.',
  };
}
